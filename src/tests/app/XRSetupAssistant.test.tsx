import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XRSetupAssistant,
  assessXrViewerReadiness,
} from "../../app/components/XRSetupAssistant";
import type { HybridWorkspaceCanvasHandle } from "../../app/components/workspace/HybridWorkspaceCanvas";
import type { XrAuthorityPollDelivery, XrAuthorityTransport } from "../../xr/authority";
import type { XrRoutableMessage } from "../../xr/protocol";
import { WebXRSessionAdapter } from "../../xr/webxr";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";

const snapshot: WorkspaceRenderSnapshot = Object.freeze({
  workspaceId: "workspace-xr-setup",
  revision: 2,
  components: Object.freeze([]),
});

function rawSession(): XRSession {
  const target = new EventTarget() as EventTarget & { end: ReturnType<typeof vi.fn> };
  target.end = vi.fn(async () => target.dispatchEvent(new Event("end")));
  return target as unknown as XRSession;
}

function canvas(): HybridWorkspaceCanvasHandle {
  return {
    getContainer: () => null,
    getRenderer: () => null,
    resize: vi.fn(),
    frameAll: vi.fn(),
    resetView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    startRealityMeasurement: vi.fn(() => false),
    cancelRealityMeasurement: vi.fn(),
    cancelActiveInteractions: vi.fn(),
    enterXR: vi.fn(async () => undefined),
    exitXR: vi.fn(async () => undefined),
    isXRPresenting: vi.fn(() => false),
  };
}

function transport(): XrAuthorityTransport {
  const identity = {
    sessionId: "session-xr-setup",
    authorityEpoch: "epoch-xr-setup",
    workspaceId: snapshot.workspaceId,
  };
  return {
    connect: vi.fn(async () => identity),
    send: vi.fn(async (message: XrRoutableMessage) => ({
      ...message,
      messageType: "ack" as const,
      status: "accepted" as const,
    })),
    poll: vi.fn(async (): Promise<readonly XrAuthorityPollDelivery[]> => []),
    createPairing: vi.fn(async () => ({
      pairingId: "pairing-xr-setup",
      pairingToken: "P".repeat(43),
      pairingCode: "482731",
      ...identity,
      expiresAtMs: Date.now() + 300_000,
    })),
    revokePairing: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
  };
}

afterEach(() => cleanup());

describe("XR viewer readiness", () => {
  it("distinguishes loopback, insecure LAN, and remotely configured HTTPS without claiming reachability", () => {
    expect(assessXrViewerReadiness("http://127.0.0.1:4174/xr.html")).toMatchObject({
      valid: true,
      usesHttps: false,
      remotelyAddressable: false,
      configuredForRemoteHeadset: false,
    });
    expect(assessXrViewerReadiness("http://192.168.8.240:4174/xr.html")).toMatchObject({
      valid: true,
      usesHttps: false,
      remotelyAddressable: true,
      configuredForRemoteHeadset: false,
    });
    expect(assessXrViewerReadiness("https://xr.semaframe.test/xr.html")).toMatchObject({
      valid: true,
      usesHttps: true,
      remotelyAddressable: true,
      configuredForRemoteHeadset: true,
      message: expect.stringContaining("remain unverified until the viewer connects"),
    });
    expect(assessXrViewerReadiness("https://user:secret@xr.test/xr.html")).toMatchObject({
      valid: false,
    });
  });
});

describe("XRSetupAssistant", () => {
  function renderAssistant(options: Readonly<{
    onConfigureVoiceRelay?: () => void;
    viewerUrl?: string;
  }> = {}) {
    const existingCanvas = canvas();
    const browserSession = rawSession();
    const runtime = {
      probe: vi.fn(async () => ({
        runtimeId: "xr-setup-test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => new WebXRSessionAdapter(
        browserSession,
        "immersive-vr",
        "local-floor",
      )),
    };
    const fakeTransport = transport();
    const onConfigureVoiceRelay = options.onConfigureVoiceRelay ?? vi.fn();
    render(<XRSetupAssistant
      sameDevice={{ getCanvas: () => existingCanvas, runtime }}
      headset={{
        snapshot,
        registryIdentity: "registry:xr-setup",
        viewerUrl: options.viewerUrl ?? "https://192.168.8.240:4174/xr.html",
        transportFactory: () => fakeTransport,
        pollIntervalMs: 10_000,
        onSelect: vi.fn(),
        onActivate: vi.fn(),
        onPanelAction: vi.fn(),
      }}
      voiceRelayArmed={false}
      onConfigureVoiceRelay={onConfigureVoiceRelay}
    />);
    return { browserSession, existingCanvas, fakeTransport, onConfigureVoiceRelay, runtime };
  }

  it("explains the same-device user-gesture boundary and enters through the existing control", async () => {
    const { existingCanvas, runtime } = renderAssistant();
    fireEvent.click(screen.getByRole("button", { name: "Open XR setup assistant" }));

    expect(screen.getByRole("dialog", { name: "Set up XR" })).toBeVisible();
    expect(screen.getByText(/an Agent cannot accept WebXR permission for you/i)).toBeVisible();
    const enter = await screen.findByRole("button", { name: "Enter XR on this device" });
    await waitFor(() => expect(enter).toBeEnabled());
    fireEvent.click(enter);

    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(existingCanvas.enterXR).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Exit XR" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry WebXR check" })).toBeDisabled();
  });

  it("guides Quest pairing with a copyable HTTPS address, six digits, and Voice Relay off by default", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { fakeTransport, onConfigureVoiceRelay } = renderAssistant();
    fireEvent.click(screen.getByRole("button", { name: "Open XR setup assistant" }));
    fireEvent.click(screen.getByRole("tab", { name: /Quest \/ remote/i }));

    expect(screen.getByText(/Do not type the long one-time link by hand/i)).toBeVisible();
    expect(screen.getByText(/Voice Relay: off \(default\)/i)).toBeVisible();
    expect(screen.getByText(/already hears the computer microphone, you do not need Voice Relay/i)).toBeVisible();
    expect(screen.getByText(/do not certify router or firewall reachability/i)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Headset viewer address" })).toHaveValue(
      "https://192.168.8.240:4174/xr.html",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://192.168.8.240:4174/xr.html"));
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(onConfigureVoiceRelay).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Set up XR" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open XR setup assistant" }));
    fireEvent.click(screen.getByRole("tab", { name: /Quest \/ remote/i }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare headset pairing" }));
    expect(await screen.findByRole("dialog", { name: "XR headset session" })).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "XR six-digit pairing code" })).toHaveValue("482731");
    expect(fakeTransport.createPairing).toHaveBeenCalledWith(300_000, { voiceRelay: false });
  });

  it("states that unavailable Ultra is gated evidence, not fabricated certification", async () => {
    renderAssistant();
    fireEvent.click(screen.getByRole("button", { name: "Open XR setup assistant" }));
    fireEvent.click(screen.getByRole("tab", { name: /Windows Ultra/i }));

    expect(screen.getByText(/trusted local evidence bridge/i)).toBeVisible();
    expect(screen.getByText(/not a hardware certification/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue Ultra verification" })).toBeDisabled();
  });

  it("blocks Quest preparation on insecure LAN HTTP without minting or exposing a pairing grant", async () => {
    const { fakeTransport } = renderAssistant({
      viewerUrl: "http://192.168.8.240:4174/xr.html",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open XR setup assistant" }));
    fireEvent.click(screen.getByRole("tab", { name: /Quest \/ remote/i }));

    const prepare = screen.getByRole("button", { name: "Prepare headset pairing" });
    expect(prepare).toBeDisabled();
    expect(screen.getAllByText(/Remote XR is blocked on plain HTTP/u).length).toBeGreaterThan(0);
    fireEvent.click(prepare);

    expect(fakeTransport.connect).not.toHaveBeenCalled();
    expect(fakeTransport.createPairing).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "XR six-digit pairing code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "XR one-time pairing link" })).not.toBeInTheDocument();
  });

  it("focuses the dialog, closes on Escape, and restores focus to the launcher", async () => {
    renderAssistant();
    const trigger = screen.getByRole("button", { name: "Open XR setup assistant" });
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close XR setup assistant" });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set up XR" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
