import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRelaySettingsDialog } from "../../app/components/VoiceRelaySettingsDialog";

afterEach(cleanup);

const target = Object.freeze({
  targetId: "codex-window",
  label: "Codex · SemaFrame",
  capabilities: Object.freeze({ draftInsertion: true, explicitSend: true, replyObservation: true }),
});

describe("VoiceRelaySettingsDialog", () => {
  it("shows only sanitized candidates and requires diagnostics before arming", async () => {
    const configure = vi.fn();
    const arm = vi.fn();
    const { rerender } = render(<VoiceRelaySettingsDialog
      open
      status={{ enabled: true, armed: false, phase: "ready", target }}
      preparation={{
        phase: "candidate_selection_required",
        platform: "macos",
        accessibility: "authorized",
        candidates: [
          { candidateId: "candidate-codex", label: "Codex · SemaFrame", applicationLabel: "Codex", compatible: true },
          { candidateId: "candidate-canvas", label: "Canvas Agent", applicationLabel: "Browser", compatible: false, incompatibilityReason: "No accessible input control" },
        ],
        configuredTarget: target,
      }}
      onClose={vi.fn()}
      onPrepare={vi.fn()}
      onConfigureTarget={configure}
      onRunDiagnostics={vi.fn()}
      onArm={arm}
      onDisarm={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: /Voice Relay/i })).toBeVisible();
    expect(screen.getByText("Accessibility: authorized")).toBeVisible();
    expect(screen.getByText("No accessible input control")).toBeVisible();
    expect(screen.getByRole("button", { name: /Arm for this session/i })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/AXUIElement|process id|window locator/i);

    await userEvent.click(screen.getAllByRole("button", { name: /Use target/i })[0]!);
    expect(configure).toHaveBeenCalledWith("candidate-codex");
    expect(screen.getByText(/text-to-speech is controlled in the headset/i)).toBeVisible();

    rerender(<VoiceRelaySettingsDialog
      open
      status={{ enabled: true, armed: false, phase: "ready", target }}
      preparation={{ phase: "ready", platform: "macos", accessibility: "authorized", candidates: [], configuredTarget: target }}
      diagnostics={{
        ready: true,
        checks: [
          { id: "helper", status: "pass", message: "Helper verified" },
          { id: "draft_insertion", status: "pass", message: "Exact round-trip passed" },
        ],
      }}
      onClose={vi.fn()}
      onPrepare={vi.fn()}
      onConfigureTarget={configure}
      onRunDiagnostics={vi.fn()}
      onArm={arm}
      onDisarm={vi.fn()}
    />);
    await userEvent.click(screen.getByRole("button", { name: /Arm for this session/i }));
    expect(arm).toHaveBeenCalledWith("codex-window");
  });

  it("disarms an armed session and closes from Escape", async () => {
    const disarm = vi.fn();
    const close = vi.fn();
    render(<VoiceRelaySettingsDialog
      open
      status={{ enabled: true, armed: true, phase: "ready", target }}
      onClose={close}
      onPrepare={vi.fn()}
      onConfigureTarget={vi.fn()}
      onRunDiagnostics={vi.fn()}
      onArm={vi.fn()}
      onDisarm={disarm}
    />);
    await userEvent.click(screen.getByRole("button", { name: /Disarm/i }));
    expect(disarm).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
  });
});
