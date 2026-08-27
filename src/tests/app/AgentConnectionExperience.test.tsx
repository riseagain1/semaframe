import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConnectionPage, type AgentConnectionPageProps } from "../../app/components/AgentConnectionPage";

afterEach(cleanup);

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
    expect(screen.getByRole("list", { name: "Agent connection progress" })).toHaveTextContent("Reading Workspace instructions");
    expect(screen.queryByText("Agent control is active")).not.toBeInTheDocument();
  });
});
