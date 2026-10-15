import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentConnectionPage,
  type AgentConnectionPageProps,
  type AgentConnectionStatus,
} from "../../app/components/AgentConnectionPage";
import type { AgentClientInstallationView, AgentInstallationClient } from "../../agent/AgentGatewayClient";

const CLIENT_NAMES = ["Codex", "Claude Code", "DeepSeek Harness (dsh)"];
const CLIENT_IDS = ["codex", "claude", "dsh"] as const;

function props(overrides: Partial<AgentConnectionPageProps> = {}): AgentConnectionPageProps {
  return {
    status: "waiting",
    connectionUrl: "http://127.0.0.1:4317/mcp/connect/non-authorizing-offer",
    onEnable: vi.fn(),
    onCopySetup: vi.fn(),
    onCopyRestSetup: vi.fn(),
    onPermissionChange: vi.fn(),
    onRevoke: vi.fn(),
    onDisableAgentControl: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRefreshAgentInstallations: vi.fn(),
    onManageAgentInstallation: vi.fn(),
    ...overrides,
  };
}

function installation(client: AgentInstallationClient, state: AgentClientInstallationView["state"]): AgentClientInstallationView {
  return {
    client, state, displayName: client === "codex" ? "Codex" : "Claude Code",
    changed: false, restartRequired: false, detail: `${client} registration: ${state}`,
  };
}

function option(client: typeof CLIENT_IDS[number]): HTMLDetailsElement {
  const details = screen.getByRole("list", { name: "Agent clients" })
    .querySelector<HTMLDetailsElement>(`details.agent-client-option[data-client="${client}"]`);
  expect(details).not.toBeNull();
  return details!;
}

function summary(client: typeof CLIENT_IDS[number]): HTMLElement {
  const element = option(client).querySelector("summary");
  expect(element).not.toBeNull();
  return element!;
}

function expectNoAuthorityAction(callbacks: AgentConnectionPageProps): void {
  for (const callback of [callbacks.onEnable, callbacks.onApprove, callbacks.onReject,
    callbacks.onPermissionChange, callbacks.onRevoke, callbacks.onDisableAgentControl]) {
    expect(callback).not.toHaveBeenCalled();
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Unified Agent client chooser", () => {
  it.each<Partial<AgentConnectionPageProps>>([
    {},
    { agentInstallationsLoading: true },
    { agentInstallationsUnavailable: "Automatic registration is unavailable on this host." },
    { status: "unavailable" },
  ])("keeps all three clients as collapsed peers without managed registration data: %j", (overrides) => {
    const callbacks = props(overrides);
    render(<AgentConnectionPage {...callbacks} />);
    const chooser = screen.getByRole("region", { name: "Connect your Agent" });
    const list = within(chooser).getByRole("list", { name: "Agent clients" });
    const peers = within(list).getAllByRole("listitem");
    expect(peers).toHaveLength(3);
    expect(screen.getAllByRole("region", { name: "Connect your Agent" })).toHaveLength(1);
    expect(screen.queryByText("External Agent")).not.toBeInTheDocument();
    CLIENT_IDS.forEach((client, index) => {
      expect(peers[index].firstElementChild).toBe(option(client));
      expect(summary(client)).toHaveTextContent(CLIENT_NAMES[index]);
      expect(summary(client)).toBeVisible();
      expect(option(client).open).toBe(false);
      expect(option(client).querySelector(".agent-client-instructions")).not.toBeVisible();
    });
    expect(within(chooser).getByText(/SemaFrame does not need your model API key/u)).toBeVisible();
    expect(within(chooser).getByText(/Setting up a connection does not grant access/u)).toBeVisible();
    expect(callbacks.onRefreshAgentInstallations).not.toHaveBeenCalled();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
  });

  it("opens and closes each native disclosure independently without launching, copying, or approving", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<AgentConnectionPage {...callbacks} />);
    const checkbox = screen.getByRole("checkbox", { name: /Allow delete and clear commands/u });
    expect(checkbox).not.toBeChecked();

    await user.click(summary("codex"));
    expect(within(option("codex")).getByText("semaframe agent install --client codex")).toBeVisible();
    expect(option("claude").open).toBe(false);
    expect(option("dsh").open).toBe(false);
    await user.click(summary("dsh"));
    expect(option("codex").open).toBe(true);
    expect(within(option("dsh")).getByText("semaframe agent launch --client dsh")).toBeVisible();
    await user.click(summary("claude"));
    expect(CLIENT_IDS.map((client) => option(client).open)).toEqual([true, true, true]);
    expect(within(option("claude")).getByText("semaframe agent install --client claude")).toBeVisible();
    await user.click(summary("codex"));
    expect(CLIENT_IDS.map((client) => option(client).open)).toEqual([false, true, true]);
    expect(within(option("codex")).getByText("semaframe agent install --client codex")).not.toBeVisible();
    expect(checkbox).not.toBeChecked();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expect(callbacks.onCopyRestSetup).not.toHaveBeenCalled();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onRefreshAgentInstallations).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
  });

  it("preserves expanded peer choices across registration and connection state updates without changing permissions", async () => {
    const user = userEvent.setup();
    const callbacks = props({ agentInstallationsLoading: true });
    const { rerender } = render(<AgentConnectionPage {...callbacks} />);
    await user.click(summary("dsh"));
    await user.click(summary("claude"));
    rerender(<AgentConnectionPage {...callbacks} agentInstallationsLoading={false} agentInstallations={{
      version: 1, clients: [installation("codex", "installed"), installation("claude", "not_installed")],
    }} />);
    expect(CLIENT_IDS.map((client) => option(client).open)).toEqual([false, true, true]);
    expect(within(option("claude")).getByRole("button", { name: "Install" })).toBeVisible();
    rerender(<AgentConnectionPage {...callbacks} status="disconnected" agentInstallationsLoading={false}
      agentInstallationsUnavailable="Registration status is temporarily unavailable." />);
    expect(CLIENT_IDS.map((client) => option(client).open)).toEqual([false, true, true]);
    expect(within(option("claude")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(option("dsh")).getByRole("button", { name: "Copy DSH configuration" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Allow delete and clear commands/u })).not.toBeChecked();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
  });

  it.each<AgentConnectionStatus>(["booting", "approval", "approved", "occupied"])("hides the entire chooser during %s", (status) => {
    const callbacks = props({ status, agentInstallations: {
      version: 1, clients: [installation("codex", "installed"), installation("claude", "not_installed")],
    } });
    const { container } = render(<AgentConnectionPage {...callbacks} />);
    expect(screen.queryByRole("region", { name: "Connect your Agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Agent clients" })).not.toBeInTheDocument();
    expect(container.querySelector(".agent-client-option")).toBeNull();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
  });

  it.each<AgentClientInstallationView["state"]>(["client_unavailable", "conflict", "error"])("retains manual instructions but offers no managed mutation for %s clients", async (state) => {
    const user = userEvent.setup();
    const callbacks = props({ agentInstallations: {
      version: 1, clients: [installation("codex", state), installation("claude", state)],
    } });
    render(<AgentConnectionPage {...callbacks} />);
    for (const client of ["codex", "claude"] as const) {
      await user.click(summary(client));
      expect(within(option(client)).getByText(`semaframe agent install --client ${client}`)).toBeVisible();
      expect(within(option(client)).getByText(`${client} registration: ${state}`)).toBeVisible();
      expect(within(option(client)).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
  });

  it("blocks duplicate and cross-client actions until an explicit managed registration finishes", async () => {
    const user = userEvent.setup();
    let finish!: (view: AgentClientInstallationView) => void;
    const onManageAgentInstallation = vi.fn(() => new Promise<AgentClientInstallationView>((resolve) => { finish = resolve; }));
    const callbacks = props({ onManageAgentInstallation, agentInstallations: {
      version: 1, clients: [installation("codex", "not_installed"), installation("claude", "outdated")],
    } });
    render(<AgentConnectionPage {...callbacks} />);
    for (const client of CLIENT_IDS) await user.click(summary(client));
    const install = within(option("codex")).getByRole("button", { name: "Install" });
    await user.click(install);
    expect(onManageAgentInstallation).toHaveBeenCalledExactlyOnceWith("codex", "install");
    expect(screen.getByRole("region", { name: "Connect your Agent" })).toHaveAttribute("aria-busy", "true");
    const update = within(option("claude")).getByRole("button", { name: "Update" });
    const remove = within(option("claude")).getByRole("button", { name: "Remove SemaFrame from Claude Code" });
    const copy = within(option("dsh")).getByRole("button", { name: "Copy DSH configuration" });
    const refresh = screen.getByRole("button", { name: "Refresh Agent client installation status" });
    for (const action of [install, update, remove, copy, refresh]) {
      expect(action).toBeDisabled();
      fireEvent.click(action);
    }
    expect(onManageAgentInstallation).toHaveBeenCalledOnce();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expect(callbacks.onRefreshAgentInstallations).not.toHaveBeenCalled();
    expectNoAuthorityAction(callbacks);
    await act(async () => finish({ ...installation("codex", "installed"), changed: true, restartRequired: true }));
    expect(screen.getByRole("region", { name: "Connect your Agent" })).not.toHaveAttribute("aria-busy");
    expect(screen.getByText(/Restart Codex once to load the stable connection/u)).toBeVisible();
    for (const action of [update, remove, copy, refresh]) expect(action).toBeEnabled();
    expect(CLIENT_IDS.map((client) => option(client).open)).toEqual([true, true, true]);
    expectNoAuthorityAction(callbacks);
  });
});
