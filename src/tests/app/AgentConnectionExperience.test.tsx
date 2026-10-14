import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConnectionPage, type AgentConnectionPageProps } from "../../app/components/AgentConnectionPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function props(overrides: Partial<AgentConnectionPageProps> = {}): AgentConnectionPageProps {
  return {
    onEnable: vi.fn(),
    onPermissionChange: vi.fn(),
    onRevoke: vi.fn(),
    onDisableAgentControl: vi.fn(),
    ...overrides,
  };
}

describe("AgentConnectionPage experience states", () => {
  it("does not offer authority while the Gateway is still booting", () => {
    render(<AgentConnectionPage {...props({ experience: { kind: "booting" } })} />);

    expect(screen.getByRole("heading", { name: "Preparing the local connection." })).toBeVisible();
    expect(screen.getByRole("status", { name: "Starting Agent Gateway" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable agent control" })).not.toBeInTheDocument();
  });

  it("offers an explicit retry without exposing a secret-bearing Gateway error", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<AgentConnectionPage {...props({
      experience: { kind: "gateway_unavailable", message: "Bearer secret=https://local.invalid/token" },
      onRetry,
    })} />);

    expect(screen.getByRole("status")).toHaveTextContent(/Start the Gateway/u);
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn’t reach the local Agent Gateway/u);
    expect(screen.getByRole("alert")).not.toHaveTextContent("local.invalid");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps approved access visibly locked until the instruction handshake completes", () => {
    render(<AgentConnectionPage {...props({
      experience: {
        kind: "approval_granted",
        client: { name: "Codex Desktop", scopes: ["workspace:read", "workspace:write"] },
      },
    })} />);

    expect(screen.getByRole("heading", { name: "Waiting for the instruction handshake." })).toBeVisible();
    expect(screen.getByRole("list", { name: "Agent connection progress" })).toHaveTextContent("Waiting for the client to request Workspace instructions");
    expect(screen.queryByText("Reading Workspace instructions")).not.toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByText(/No repeated approval is needed/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Agent control is active")).not.toBeInTheDocument();
  });

  it("counts down the pending request and disables approval at its own deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const onApprove = vi.fn();
    render(<AgentConnectionPage {...props({
      experience: {
        kind: "approval_pending",
        client: { name: "DSH", scopes: ["workspace:read"] },
        expiresAt: "2030-01-01T00:02:00.000Z",
      },
      expiresAt: "2030-01-01T01:00:00.000Z",
      onApprove,
    })} />);
    const approve = screen.getByRole("button", { name: "Approve client" });
    expect(screen.getByRole("timer")).toHaveTextContent("Approval request: 2:00 remaining");
    expect(approve).toBeEnabled();
    act(() => { vi.advanceTimersByTime(119_000); });
    expect(screen.getByRole("timer")).toHaveTextContent("0:01 remaining");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByRole("timer")).toHaveTextContent("Approval request expired");
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByText(/This expired request cannot grant access/u)).toBeVisible();
  });

  it("uses the approved handshake retry window rather than the earlier offer deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const client = { name: "DeepSeek Harness", clientId: "dsh · a1:b2:c3", scopes: ["workspace:read"] };
    const callbacks = props({
      experience: {
        kind: "approval_granted", client, handshakeStatus: "waiting",
        expiresAt: "2030-01-01T00:10:00.000Z",
      },
      expiresAt: "2030-01-01T00:00:05.000Z",
      onApprove: vi.fn(),
      onEnable: vi.fn(),
    });
    const { rerender } = render(<AgentConnectionPage {...callbacks} />);
    expect(screen.getByText("dsh · a1:b2:c3")).toBeVisible();
    expect(screen.getByRole("timer")).toHaveTextContent("Retry window: 10:00 remaining");
    expect(screen.queryByText("Reading Workspace instructions")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(screen.getByRole("timer")).toHaveTextContent("9:54 remaining");
    rerender(<AgentConnectionPage {...callbacks} experience={{
      kind: "approval_granted", client, handshakeStatus: "in_flight",
      expiresAt: "2030-01-01T00:10:00.000Z",
    }} />);
    expect(screen.getByText("Reading Workspace instructions")).toBeVisible();
    expect(screen.getByText(/An instruction request is in progress/u)).toBeVisible();
    act(() => { vi.advanceTimersByTime(594_000); });
    expect(screen.getByRole("timer")).toHaveTextContent("Retry window expired");
    expect(screen.getByText(/An instruction request already in progress may still finish/u)).toBeVisible();
    expect(callbacks.onApprove).not.toHaveBeenCalled();
    expect(callbacks.onEnable).not.toHaveBeenCalled();
    expect(screen.queryByText("Agent control is active")).not.toBeInTheDocument();
  });

  it("shows recovery if an approved but idle client's retry window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
    render(<AgentConnectionPage {...props({ experience: {
      kind: "approval_granted",
      client: { name: "DSH", scopes: ["workspace:read"] },
      handshakeStatus: "waiting",
      expiresAt: "2030-01-01T00:10:00.000Z",
    } })} />);
    expect(screen.getByRole("timer")).toHaveTextContent("Retry window expired");
    expect(screen.getByText(/Ask the client to reconnect and review a fresh approval request/u)).toBeVisible();
  });

  it.each([
    ["approval_expired", "The approval request expired before it was approved"],
    ["handshake_expired", "The approved client did not finish the instruction handshake in time"],
    ["offer_expired", "The previous connection offer expired"],
  ] as const)("explains %s after rotation without exposing stale metadata or requesting scopes", (reason, title) => {
    const callbacks = props({
      experience: {
        kind: "offer_ready",
        url: "http://127.0.0.1:8788/mcp/connect/fresh-offer",
        notice: { reason, occurredAt: "2030-01-01T00:10:00.000Z" },
      },
      pairedClient: { name: "Expired client", clientId: "old-private-token", scopes: ["workspace:clear"] },
      onApprove: vi.fn(),
    });
    const { container } = render(<AgentConnectionPage {...callbacks} />);
    expect(screen.getByRole("status", { name: "Connection recovery notice" })).toHaveTextContent(title);
    expect(screen.getByRole("heading", { name: "Give this connection to your client." })).toBeVisible();
    expect(container).not.toHaveTextContent("Expired client");
    expect(container).not.toHaveTextContent("old-private-token");
    expect(container).not.toHaveTextContent("workspace:clear");
    expect(screen.queryByRole("button", { name: "Approve client" })).not.toBeInTheDocument();
    expect(callbacks.onApprove).not.toHaveBeenCalled();
  });
});
