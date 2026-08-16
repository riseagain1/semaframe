import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentConnectionPage,
  type AgentConnectionPageProps,
} from "../../app/components/AgentConnectionPage";
import { AgentGatewayError, type AgentGatewayConfig } from "../../agent/AgentGatewayClient";
import { AgentHistoryDrawer, AgentWorkspaceControls } from "../../app/components/AgentWorkspaceControls";
import type { WorkspaceHistoryEntry } from "../../app/uiTypes";
import {
  isAgentWorkspaceUnlocked,
  replaceAgentOfferAndRestoreBridge,
  restoreAgentBrowserBridge,
} from "../../app/App";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function connectionProps(overrides: Partial<AgentConnectionPageProps> = {}): AgentConnectionPageProps {
  return {
    status: "waiting",
    onEnable: vi.fn(),
    onCopySetup: vi.fn(() => "fallback setup"),
    onPermissionChange: vi.fn(),
    onRevoke: vi.fn(),
    onDisableAgentControl: vi.fn(),
    ...overrides,
  };
}

describe("Agent connection offer lifecycle", () => {
  it("keeps the Workspace gated until the instruction handshake is active", () => {
    expect(isAgentWorkspaceUnlocked(false, "disabled")).toBe(false);
    expect(isAgentWorkspaceUnlocked(false, "connected")).toBe(false);
    expect(isAgentWorkspaceUnlocked(true, "disconnected")).toBe(false);
    expect(isAgentWorkspaceUnlocked(true, "connected")).toBe(true);
    expect(isAgentWorkspaceUnlocked(true, "applying")).toBe(true);
  });

  const replacementConfig: AgentGatewayConfig = {
    version: 1,
    gatewayInstanceId: "gateway-restarted-test",
    configRevision: 2,
    enabled: true,
    connected: false,
    engineConnected: false,
    instructionVersion: "workspace-guide-test",
    csrfToken: "csrf-restarted-test",
    connectionUrl: "http://127.0.0.1:4317/mcp/connect/fresh-offer",
    offerStatus: "waiting",
  };

  it("waits for a stale polling loop before reclaiming a restarted gateway", async () => {
    const events: string[] = [];
    let finishPreviousRun!: () => void;
    const previousRun = new Promise<void>((resolve) => { finishPreviousRun = resolve; });
    const client = {
      running: true,
      start: vi.fn(() => previousRun),
      stop: vi.fn(() => { events.push("stop"); }),
    };
    const claimAndStart = vi.fn(async () => {
      events.push("claim");
      return true;
    });

    const restored = restoreAgentBrowserBridge(client, replacementConfig, claimAndStart);
    await Promise.resolve();
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledWith("disconnected");
    expect(claimAndStart).not.toHaveBeenCalled();

    finishPreviousRun();
    await expect(restored).resolves.toBe(true);
    expect(events).toEqual(["stop", "claim"]);
  });

  it("reclaims when the local poll stopped and propagates an occupied result", async () => {
    const client = {
      running: false,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const claimAndStart = vi.fn(async () => false);

    await expect(restoreAgentBrowserBridge(
      client,
      { engineConnected: true },
      claimAndStart,
    )).resolves.toBe(false);

    expect(claimAndStart).toHaveBeenCalledOnce();
    expect(client.start).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("preserves local sessions when remote offer rotation is not confirmed", async () => {
    const remoteFailure = new Error("rotation timed out");
    const revokeLocalSessions = vi.fn();
    const restoreBridge = vi.fn();

    await expect(replaceAgentOfferAndRestoreBridge(
      async () => { throw remoteFailure; },
      revokeLocalSessions,
      restoreBridge,
    )).rejects.toBe(remoteFailure);

    expect(revokeLocalSessions).not.toHaveBeenCalled();
    expect(restoreBridge).not.toHaveBeenCalled();
  });

  it("commits the replacement before restoring its browser lease", async () => {
    const events: string[] = [];
    const bridgeReady = await replaceAgentOfferAndRestoreBridge(
      async () => replacementConfig,
      () => { events.push("replace"); },
      async () => { events.push("restore"); return false; },
    );

    expect(bridgeReady).toBe(false);
    expect(events).toEqual(["replace", "restore"]);
  });
});

describe("AgentConnectionPage", () => {
  it("shows the SemaFrame lockup on the standalone connection gate only", () => {
    const { rerender } = render(<AgentConnectionPage {...connectionProps()} />);
    expect(screen.getByLabelText("SemaFrame")).toBeVisible();

    rerender(<AgentConnectionPage {...connectionProps({ onClose: vi.fn() })} />);
    expect(screen.queryByLabelText("SemaFrame")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to workspace" })).toBeVisible();
  });

  it("shows the actual connection URL and copies only on a user action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const onCopySetup = vi.fn(() => "secret fallback that should not be requested");

    render(<AgentConnectionPage {...connectionProps({
      connectionUrl: "http://127.0.0.1:4317/connect/offer-123",
      expiresAt: "2099-08-14T10:00:00.000Z",
      onCopySetup,
    })} />);

    const field = screen.getByRole("textbox", { name: "Connection URL" });
    expect(field).toHaveValue("http://127.0.0.1:4317/connect/offer-123");
    expect(screen.getByText(/Paste this address into the agent client/i)).toBeVisible();
    expect(screen.getAllByText(/Realtime and voice agents use the same connection/i)).toHaveLength(2);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.focus(field);
    expect((field as HTMLInputElement).selectionStart).toBe(0);
    await user.click(screen.getByRole("button", { name: "Copy connection URL" }));
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:4317/connect/offer-123");
    expect(onCopySetup).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connection URL copied" })).toBeVisible();
  });

  it("reveals the credentialed local setup only through an explicit advanced copy action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const secretSetup = '{"env":{"SEMAFRAME_AGENT_TOKEN":"private-bearer"}}';
    const onCopySetup = vi.fn(() => ({ mcpConfig: secretSetup }));

    const { container } = render(<AgentConnectionPage {...connectionProps({
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/public-offer",
      onCopySetup,
    })} />);

    expect(onCopySetup).not.toHaveBeenCalled();
    expect(container).not.toHaveTextContent("private-bearer");
    await user.click(screen.getByText("Advanced local setup"));
    await user.click(screen.getByRole("button", { name: "Copy local stdio/REST setup" }));

    expect(onCopySetup).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(secretSetup);
    expect(screen.getByRole("button", { name: "Local setup copied" })).toBeVisible();
    expect(container).not.toHaveTextContent("private-bearer");
  });

  it("offers an explicit fresh URL action while waiting and disconnected", async () => {
    const user = userEvent.setup();
    const onRefreshOffer = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<AgentConnectionPage {...connectionProps({
      status: "waiting",
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-old",
      onRefreshOffer,
    })} />);

    await user.click(screen.getByRole("button", { name: "Create fresh URL" }));
    expect(onRefreshOffer).toHaveBeenCalledOnce();

    rerender(<AgentConnectionPage {...connectionProps({
      status: "disconnected",
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-old",
      onRefreshOffer,
    })} />);
    expect(screen.getByRole("button", { name: "Create fresh URL" })).toBeVisible();
  });

  it("gives safe recovery guidance when the gateway cannot be reached", async () => {
    const user = userEvent.setup();
    render(<AgentConnectionPage {...connectionProps({
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-old",
      onRefreshOffer: vi.fn().mockRejectedValue(new TypeError(
        "Failed to fetch http://127.0.0.1:4317/mcp/connect/private-offer",
      )),
    })} />);

    await user.click(screen.getByRole("button", { name: "Create fresh URL" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t reach the local Agent Gateway");
    expect(alert).not.toHaveTextContent("private-offer");
  });

  it("distinguishes gateway restart and incompatible response failures", async () => {
    const user = userEvent.setup();
    const onRefreshOffer = vi.fn()
      .mockRejectedValueOnce(new AgentGatewayError(
        "request_failed",
        "The local agent gateway rejected the request (403).",
        { status: 403, gatewayCode: "csrf_invalid" },
      ))
      .mockRejectedValueOnce(new AgentGatewayError(
        "invalid_response",
        "private response details must not be displayed",
      ));
    render(<AgentConnectionPage {...connectionProps({
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-old",
      onRefreshOffer,
    })} />);

    const refresh = screen.getByRole("button", { name: "Create fresh URL" });
    await user.click(refresh);
    expect(await screen.findByRole("alert")).toHaveTextContent("browser session expired");
    await user.click(refresh);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("incompatible connection data");
    expect(alert).not.toHaveTextContent("private response details");
  });

  it("keeps safe local action guidance but suppresses secret-bearing errors", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn()
      .mockRejectedValueOnce(new Error("Wait for the current workspace change to finish."))
      .mockRejectedValueOnce(new Error("approval_token=do-not-display"));
    render(<AgentConnectionPage {...connectionProps({
      status: "disconnected",
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-old",
      onRetry,
    })} />);

    const retry = screen.getByRole("button", { name: "Retry connection" });
    await user.click(retry);
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait for the current workspace change to finish.");
    await user.click(retry);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The local Agent Gateway could not complete that action. Try again.");
    expect(alert).not.toHaveTextContent("do-not-display");
  });

  it("stops copying a connection URL when its local expiry passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T08:00:00.000Z"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AgentConnectionPage {...connectionProps({
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-expiring",
      expiresAt: "2026-08-14T08:00:01.000Z",
      onRefreshOffer: vi.fn(),
    })} />);

    expect(screen.getByRole("button", { name: "Copy connection URL" })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(1_001); });
    const expiredCopy = screen.getByRole("button", { name: "Connection URL expired" });
    expect(expiredCopy).toBeDisabled();
    fireEvent.click(expiredCopy);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("presents pending client identity and requires an explicit approval", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<AgentConnectionPage {...connectionProps({
      status: "approval",
      pairedClient: { name: "Codex Desktop", clientId: "client-local", scopes: ["workspace:read", "workspace:write"] },
      onApprove,
      onReject,
    })} />);

    expect(screen.getByRole("heading", { name: "A client is asking to control this workspace." })).toBeVisible();
    expect(screen.getByText("Codex Desktop")).toBeVisible();
    expect(screen.getByText("workspace:write")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve client" }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("shows the destructive policy only when a Workspace client requests destructive scopes", async () => {
    const user = userEvent.setup();
    const onPermissionChange = vi.fn();
    const { rerender } = render(<AgentConnectionPage {...connectionProps({
      status: "approval",
      pairedClient: {
        name: "Safe Workspace agent",
        scopes: ["workspace:read", "workspace:write", "component:create"],
      },
      onPermissionChange,
    })} />);

    expect(screen.queryByRole("checkbox", { name: /delete and clear commands/i })).not.toBeInTheDocument();

    rerender(<AgentConnectionPage {...connectionProps({
      status: "approval",
      pairedClient: {
        name: "Destructive Workspace agent",
        scopes: ["workspace:read", "workspace:write", "component:delete", "workspace:clear"],
      },
      onPermissionChange,
    })} />);

    const permission = screen.getByRole("checkbox", { name: /Allow requested delete and clear commands/i });
    expect(permission).not.toBeChecked();
    await user.click(permission);
    expect(onPermissionChange).toHaveBeenCalledWith(true);
  });

  it("supports connected management without reusing waiting copy", async () => {
    const user = userEvent.setup();
    const onPermissionChange = vi.fn();
    const onRevoke = vi.fn();
    const onDisableAgentControl = vi.fn();
    const onClose = vi.fn();
    render(<AgentConnectionPage {...connectionProps({
      status: "connected",
      pairedClient: { name: "Claude Code", scopes: ["workspace:read", "workspace:write", "component:delete"], connected: true },
      onPermissionChange,
      onRevoke,
      onDisableAgentControl,
      onClose,
    })} />);

    expect(screen.getByRole("heading", { name: "This workspace is under external control." })).toBeVisible();
    expect(screen.queryByText("Paste this into your client")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to workspace" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("checkbox", { name: /Allow delete and clear commands/i }));
    expect(onPermissionChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Revoke pairing" }));
    expect(screen.getByText("Revoke the current pairing?")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Revoke pairing" }));
    expect(onRevoke).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Disable agent control" }));
    expect(onDisableAgentControl).toHaveBeenCalledOnce();
  });

  it("closes connected management with Escape and restores its opener", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Manage connection</button>
        {open && <AgentConnectionPage {...connectionProps({
          status: "connected",
          pairedClient: { name: "Codex", scopes: ["workspace:read", "workspace:write"], connected: true },
          onClose: () => setOpen(false),
        })} />}
      </>;
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Manage connection" });
    await user.click(opener);
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to workspace" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Back to workspace" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the destructive permission off when enabling by default", async () => {
    const user = userEvent.setup();
    const onEnable = vi.fn();
    render(<AgentConnectionPage {...connectionProps({ status: "disabled", allowDeleteAndClear: true, onEnable })} />);

    expect(screen.getByRole("checkbox", { name: /Allow delete and clear commands/i })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Enable agent control" }));
    expect(onEnable).toHaveBeenCalledWith(false);
  });

  it("keeps a tab conflict inline and requires confirmation before takeover", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onTakeover = vi.fn().mockResolvedValue(undefined);
    const onDisableAgentControl = vi.fn();
    render(<AgentConnectionPage {...connectionProps({
      status: "occupied",
      connectionUrl: "http://127.0.0.1:4317/mcp/connect/offer-hidden",
      onRetry,
      onTakeover,
      onDisableAgentControl,
    })} />);

    expect(screen.getByRole("heading", { name: "Another tab owns Agent control." })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No workspace change was made here");
    expect(screen.queryByRole("textbox", { name: "Connection URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Allow delete and clear commands/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try this tab again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Move control to this tab" }));
    expect(onTakeover).not.toHaveBeenCalled();
    expect(screen.getByText("Move Agent control to this tab?")).toBeVisible();
    expect(screen.getByText(/unsaved workspace state is not copied between tabs/i)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Move control here" }));
    expect(onTakeover).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Release this tab" }));
    expect(onDisableAgentControl).toHaveBeenCalledOnce();
  });
});

describe("Agent workspace controls", () => {
  it("offers compact History and Manage controls", async () => {
    const user = userEvent.setup();
    const onHistory = vi.fn();
    const onManage = vi.fn();
    render(<AgentWorkspaceControls status="applying" clientName="Codex" historyCount={3} onHistory={onHistory} onManage={onManage} />);

    expect(screen.getByRole("status")).toHaveTextContent("Applying Codex change");
    await user.click(screen.getByRole("button", { name: /History.*3 entries/i }));
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(onHistory).toHaveBeenCalledOnce();
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("hides covered workspace controls from keyboard and assistive interaction", () => {
    const { container } = render(<AgentWorkspaceControls
      status="connected"
      clientName="Codex"
      historyCount={1}
      manageExpanded
      onHistory={vi.fn()}
      onManage={vi.fn()}
    />);
    const controls = container.querySelector(".agent-workspace-controls");
    expect(controls).toHaveAttribute("inert");
    expect(controls).toHaveAttribute("aria-hidden", "true");
  });

  it("shows agent provenance in a nonmodal drawer and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const entries: WorkspaceHistoryEntry[] = [{
      id: "entry-1",
      inputRevision: 4,
      text: "The agent moved the lamp.",
      status: "committed",
      source: "agent",
      clientName: "Codex Desktop",
      traceId: "trace-1234567890",
    }];

    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open history</button>
        <AgentHistoryDrawer open={open} entries={entries} onClose={() => setOpen(false)} />
      </>;
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open history" });
    await user.click(opener);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Agent · Codex Desktop")).toBeVisible();
    expect(screen.getByText("Trace trace-12")).toHaveAttribute("title", "trace-1234567890");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close workspace history" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Workspace history" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

});
