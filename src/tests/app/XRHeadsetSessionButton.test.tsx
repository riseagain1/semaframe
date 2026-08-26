import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XRHeadsetSessionButton,
  __xrHeadsetSessionTest,
  type XRHeadsetSessionButtonHandle,
} from "../../app/components/XRHeadsetSessionButton";
import { AgentWorkspaceGate } from "../../app/components/AgentWorkspaceGate";
import type { XrAuthorityPollDelivery, XrAuthorityTransport } from "../../xr/authority";
import type { XrRoutableMessage } from "../../xr/protocol";
import { createXRContextEnvelope } from "../../xr/client";
import { assetIdFromDigest, type RealityAssetDescriptor } from "../../workspace/assets";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";

const snapshot: WorkspaceRenderSnapshot = Object.freeze({
  workspaceId: "workspace-headset-test",
  revision: 0,
  components: Object.freeze([]),
});
const relayTiming = Object.freeze({ serverReceivedAtMs: 1_000, serverQueueAgeMs: 0 });
const interactiveSnapshot: WorkspaceRenderSnapshot = Object.freeze({
  workspaceId: snapshot.workspaceId,
  revision: 0,
  components: Object.freeze([{
    id: "button",
    type: { typeId: "button", version: "1", digest: "digest:test" },
    label: "Run",
    props: {},
    durableState: {},
    placement: {
      space: "viewport" as const,
      anchor: "center" as const,
      offset: { x: 0, y: 0 },
      size: { width: 120, height: 44 },
      zIndex: 1,
    },
    tags: [],
    visibility: "visible" as const,
    locks: { placement: false },
  }]),
});
const realityDigest = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as const;

function realityDescriptor(): RealityAssetDescriptor {
  return {
    version: 1,
    assetId: assetIdFromDigest(realityDigest),
    digest: realityDigest,
    format: "ply",
    formatVersion: 1,
    mediaType: "application/ply",
    byteLength: 3,
    splatCount: 1,
    sphericalHarmonicsDegree: 0,
    model: "gaussian-3d",
    antialiased: null,
    coordinateSystem: { system: "UNKNOWN", provenance: "unknown" },
    engineeringAuthority: "visual_only",
  };
}

function realitySnapshot(revision: number): WorkspaceRenderSnapshot {
  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    revision,
    components: Object.freeze([]),
    realityAssets: Object.freeze([realityDescriptor()]),
  });
}

afterEach(() => cleanup());

function transport() {
  const identity = {
    sessionId: "session-authority-test",
    authorityEpoch: "epoch-authority-test",
    workspaceId: snapshot.workspaceId,
  };
  const implementation = {
    connect: vi.fn(async () => identity),
    send: vi.fn(async (message: XrRoutableMessage) => ({
      ...message,
      messageType: "ack" as const,
      status: "accepted" as const,
    })),
    poll: vi.fn(async (): Promise<readonly XrAuthorityPollDelivery[]> => []),
    createPairing: vi.fn(async () => ({
      pairingId: "pairing-headset-test",
      pairingToken: "A".repeat(43),
      pairingCode: "012345",
      ...identity,
      expiresAtMs: Date.now() + 300_000,
    })),
    revokePairing: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
  } satisfies XrAuthorityTransport;
  return implementation;
}

describe("XRHeadsetSessionButton", () => {
  it("starts one authoritative projection, mints a fragment pairing link, and disconnects cleanly", async () => {
    const fake = transport();
    const onPhaseChange = vi.fn();
    render(<XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1_000}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
      onPhaseChange={onPhaseChange}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    const link = await screen.findByRole("textbox", { name: "XR one-time pairing link" });
    expect(link).toHaveValue(`https://viewer.semaframe.test/xr.html#pair=${"A".repeat(43)}`);
    expect(screen.getByRole("textbox", { name: "XR six-digit pairing code" })).toHaveValue("012345");
    expect(screen.getByText("6-digit pairing code")).toBeVisible();
    expect(screen.getByText("Secure one-time link")).toBeVisible();
    expect(fake.connect).toHaveBeenCalledWith(snapshot.workspaceId);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.createPairing).toHaveBeenCalledWith(300_000, { voiceRelay: false });
    expect(screen.getByRole("button", { name: "Manage XR headset session" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(fake.disconnect).toHaveBeenCalledTimes(1));
    expect(fake.revokePairing).toHaveBeenCalledWith("pairing-headset-test");
    expect(onPhaseChange).toHaveBeenCalledWith("idle", "Headset session stopped.");
  });

  it("returns a locally released but unconfirmed outcome when relay disconnect fails", async () => {
    const fake = transport();
    fake.disconnect.mockRejectedValueOnce(new Error("relay disconnect failed"));
    const control = createRef<XRHeadsetSessionButtonHandle>();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1_000}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR six-digit pairing code" });

    const outcome = await control.current!.stop();

    expect(outcome).toEqual({ locallyReleased: true, teardownConfirmed: false });
    expect(fake.disconnect).toHaveBeenCalledOnce();
    await waitFor(() => expect(control.current?.inspect().phase).toBe("error"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Headset projection was released locally, but relay teardown could not be confirmed.",
    );
  });

  it("keeps the XR authority and projection alive while the Agent connection gate covers the desktop", async () => {
    const fake = transport();
    const control = createRef<XRHeadsetSessionButtonHandle>();
    const revisionOne = Object.freeze({ ...snapshot, revision: 1 });
    const harness = (active: boolean, currentSnapshot: WorkspaceRenderSnapshot) => <AgentWorkspaceGate
      active={active}
      connection={<p>Authorize an Agent to continue.</p>}
    >
      <XRHeadsetSessionButton
        ref={control}
        snapshot={currentSnapshot}
        registryIdentity="registry:test"
        viewerUrl="https://viewer.semaframe.test/xr.html"
        transportFactory={() => fake}
        pollIntervalMs={1_000}
        desktopControlsVisible={active}
        onSelect={vi.fn()}
        onActivate={vi.fn()}
        onPanelAction={vi.fn()}
      />
    </AgentWorkspaceGate>;
    const view = render(harness(true, snapshot));

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR six-digit pairing code" });
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.createPairing).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledTimes(1);

    view.rerender(harness(false, revisionOne));

    expect(screen.getByRole("main", { name: "Agent connection" })).toBeVisible();
    expect(screen.queryByRole("main", { name: "Workspace" })).not.toBeInTheDocument();
    const gatedWorkspace = document.getElementById("workspace-panel");
    expect(gatedWorkspace).not.toBeNull();
    expect(gatedWorkspace).toHaveAttribute("aria-hidden", "true");
    expect(gatedWorkspace).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Manage XR headset session" })).not.toBeInTheDocument();
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(fake.revokePairing).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));

    view.rerender(harness(true, revisionOne));
    expect(screen.queryByRole("main", { name: "Agent connection" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage XR headset session" })).toHaveAttribute("aria-pressed", "true");
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.createPairing).toHaveBeenCalledOnce();
    expect(fake.disconnect).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => expect(fake.disconnect).toHaveBeenCalledOnce());
  });

  it("revokes the old one-time pairing before changing its Voice Relay policy", async () => {
    const fake = transport();
    let pairingSequence = 0;
    fake.createPairing.mockImplementation(async () => {
      pairingSequence += 1;
      return {
        pairingId: `pairing-headset-test-${pairingSequence}`,
        pairingToken: (pairingSequence === 1 ? "A" : "B").repeat(43),
        pairingCode: pairingSequence === 1 ? "012345" : "678901",
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        expiresAtMs: Date.now() + 300_000,
      };
    });
    const control = createRef<XRHeadsetSessionButtonHandle>();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1_000}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    expect(await screen.findByRole("textbox", { name: "XR one-time pairing link" }))
      .toHaveValue(`https://viewer.semaframe.test/xr.html#pair=${"A".repeat(43)}`);

    await act(async () => control.current!.setVoiceRelayEnabled(true));

    expect(fake.revokePairing).toHaveBeenCalledWith("pairing-headset-test-1");
    expect(fake.revokePairing.mock.invocationCallOrder[0]).toBeLessThan(
      fake.createPairing.mock.invocationCallOrder[1]!,
    );
    expect(fake.createPairing).toHaveBeenNthCalledWith(1, 300_000, { voiceRelay: false });
    expect(fake.createPairing).toHaveBeenNthCalledWith(2, 300_000, { voiceRelay: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "XR one-time pairing link" }))
      .toHaveValue(`https://viewer.semaframe.test/xr.html#pair=${"B".repeat(43)}`));
  });

  it("does not mint a replacement capability when old-pairing revocation remains unresolved", async () => {
    const fake = transport();
    fake.revokePairing.mockRejectedValue(new Error("lost revoke acknowledgement"));
    const control = createRef<XRHeadsetSessionButtonHandle>();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1_000}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR one-time pairing link" });

    let failure: unknown;
    await act(async () => {
      try {
        await control.current!.setVoiceRelayEnabled(true);
      } catch (cause) {
        failure = cause;
      }
    });
    expect(failure).toEqual(expect.objectContaining({ message: "lost revoke acknowledgement" }));

    expect(fake.createPairing).toHaveBeenCalledOnce();
    await waitFor(() => expect(fake.disconnect).toHaveBeenCalledOnce());
    await waitFor(() => expect(
      screen.queryByRole("textbox", { name: "XR one-time pairing link" }),
    ).not.toBeInTheDocument());
    expect(await screen.findByText(/could not be proven revoked/i)).toBeVisible();
  });

  it("publishes an authenticated session-control exit request only after the renderer is active", async () => {
    const fake = transport();
    const delivery = {
      deliveryId: "delivery-active-presence-for-exit",
      sourceSessionId: "session-renderer-test",
      ...relayTiming,
      message: {
        protocolVersion: 1 as const,
        messageType: "ephemeral" as const,
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        revision: snapshot.revision,
        requestId: "request-active-presence-for-exit",
        channel: "xr.session.presence",
        sequence: 1,
        payload: {
          phase: "active",
          sourceSessionId: "session-renderer-test",
          sourcePairingId: "pairing-headset-test",
          serverReceivedAtMs: Date.now(),
        },
      },
    };
    let acknowledged = false;
    fake.poll.mockImplementation(async (acknowledgedIds: readonly string[] = []) => {
      if (acknowledgedIds.includes(delivery.deliveryId)) acknowledged = true;
      return acknowledged ? [] : [delivery];
    });
    const control = createRef<XRHeadsetSessionButtonHandle>();
    const onPhaseChange = vi.fn();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
      onPhaseChange={onPhaseChange}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await waitFor(() => expect(onPhaseChange).toHaveBeenCalledWith(
      "active",
      "Headset paired · immersive XR is active.",
    ));

    let requested = false;
    await act(async () => { requested = await control.current!.requestExit(); });
    expect(requested).toBe(true);
    expect(fake.send).toHaveBeenCalledWith(expect.objectContaining({
      messageType: "ephemeral",
      channel: "xr.session.control",
      payload: { action: "request_exit", targetSessionId: "session-renderer-test" },
    }));
  });

  it("retains distinct headset lifecycle transitions that arrive in one poll", async () => {
    const fake = transport();
    const serverReceivedAtMs = Date.now();
    const deliveries: readonly XrAuthorityPollDelivery[] = ["ended", "replica_ready"].map((phase, index) => ({
      deliveryId: `delivery-lifecycle-${phase}`,
      sourceSessionId: "session-renderer-test",
      ...relayTiming,
      message: {
        protocolVersion: 1 as const,
        messageType: "ephemeral" as const,
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        revision: snapshot.revision,
        requestId: `request-lifecycle-${phase}`,
        channel: "xr.session.presence",
        sequence: index + 1,
        payload: {
          phase,
          sourceSessionId: "session-renderer-test",
          sourcePairingId: "pairing-headset-test",
          serverReceivedAtMs: serverReceivedAtMs + index,
        },
      },
    })) as readonly XrAuthorityPollDelivery[];
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => (
      deliveries.filter((delivery) => !acknowledged.includes(delivery.deliveryId))
    ));
    const control = createRef<XRHeadsetSessionButtonHandle>();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await waitFor(() => expect(control.current?.inspect().lifecycleSequence).toBe(2));

    const first = control.current!.readLifecycleTransition(0);
    expect(first).toMatchObject({ sequence: 1, phase: "ended", serverReceivedAtMs });
    expect(control.current!.readLifecycleTransition(first!.sequence)).toMatchObject({
      sequence: 2,
      phase: "replica_ready",
      serverReceivedAtMs: serverReceivedAtMs + 1,
    });
  });

  it("removes the consumed code and link after replica readiness while retaining non-secret active-session identity", async () => {
    const fake = transport();
    const serverReceivedAtMs = Date.now();
    let releasePresence = false;
    const deliveries: readonly XrAuthorityPollDelivery[] = ["replica_ready", "active"].map((phase, index) => ({
      deliveryId: `delivery-secret-clearing-${phase}`,
      sourceSessionId: "session-renderer-test",
      ...relayTiming,
      message: {
        protocolVersion: 1 as const,
        messageType: "ephemeral" as const,
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        revision: snapshot.revision,
        requestId: `request-secret-clearing-${phase}`,
        channel: "xr.session.presence",
        sequence: index + 1,
        payload: {
          phase,
          sourceSessionId: "session-renderer-test",
          sourcePairingId: "pairing-headset-test",
          serverReceivedAtMs: serverReceivedAtMs + index,
        },
      },
    })) as readonly XrAuthorityPollDelivery[];
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => (
      releasePresence
        ? deliveries.filter((delivery) => !acknowledged.includes(delivery.deliveryId))
        : []
    ));
    const control = createRef<XRHeadsetSessionButtonHandle>();
    render(<XRHeadsetSessionButton
      ref={control}
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    expect(await screen.findByRole("textbox", { name: "XR six-digit pairing code" })).toHaveValue("012345");
    expect(screen.getByRole("textbox", { name: "XR one-time pairing link" })).toBeVisible();

    releasePresence = true;
    await waitFor(() => expect(control.current?.inspect().lastLifecyclePhase).toBe("active"));
    expect(screen.queryByRole("textbox", { name: "XR six-digit pairing code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "XR one-time pairing link" })).not.toBeInTheDocument();
    expect(control.current?.inspect()).toMatchObject({ phase: "active", pairingReady: false });
  });

  it("rejects credential-bearing or query-bearing viewer configuration before retaining a grant", async () => {
    expect(() => __xrHeadsetSessionTest.canonicalViewerUrl("https://user:secret@example.test/xr.html"))
      .toThrow(/without credentials/u);
    expect(() => __xrHeadsetSessionTest.pairingUrl("https://example.test/xr.html?leak=1", "secret"))
      .toThrow(/query parameters/u);

    const fake = transport();
    render(<XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html?bad=1"
      transportFactory={() => fake}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    expect(await screen.findByText(/without credentials, query parameters, or a fragment/u)).toBeVisible();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "XR one-time pairing link" })).not.toBeInTheDocument();
  });

  it("starts and pairs after the React StrictMode setup-cleanup-setup cycle", async () => {
    const fake = transport();
    render(<StrictMode><XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1_000}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    /></StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));

    expect(await screen.findByRole("textbox", { name: "XR one-time pairing link" }))
      .toHaveValue(`https://viewer.semaframe.test/xr.html#pair=${"A".repeat(43)}`);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.createPairing).toHaveBeenCalledTimes(1);
  });

  it("rechecks relay residency and re-uploads an evicted Reality Asset before publishing its next revision", async () => {
    let resident = false;
    const hasAsset = vi.fn(async () => resident);
    const putAsset = vi.fn(async () => {
      resident = true;
      return {};
    });
    const fake = Object.assign(transport(), { hasAsset, putAsset });
    const openRealityAsset = vi.fn(async () => new Blob(["abc"], { type: "application/ply" }));
    const common = {
      registryIdentity: "registry:test",
      viewerUrl: "https://viewer.semaframe.test/xr.html",
      transportFactory: () => fake,
      openRealityAsset,
      pollIntervalMs: 1_000,
      onSelect: vi.fn(),
      onActivate: vi.fn(),
      onPanelAction: vi.fn(),
    } as const;
    const view = render(<XRHeadsetSessionButton snapshot={realitySnapshot(0)} {...common} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR one-time pairing link" });
    await waitFor(() => expect(hasAsset).toHaveBeenCalledTimes(4));
    expect(putAsset).toHaveBeenCalledTimes(1);
    expect(openRealityAsset).toHaveBeenCalledTimes(1);

    // Simulate relay LRU eviction after the initial revision was published.
    resident = false;
    view.rerender(<XRHeadsetSessionButton snapshot={realitySnapshot(1)} {...common} />);

    await waitFor(() => expect(putAsset).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.send.mock.calls.some(([message]) => message.revision === 1)).toBe(true));
    expect(openRealityAsset).toHaveBeenCalledTimes(2);
    const revisionOneSendIndex = fake.send.mock.calls.findIndex(([message]) => message.revision === 1);
    expect(revisionOneSendIndex).toBeGreaterThanOrEqual(0);
    expect(putAsset.mock.invocationCallOrder[1]).toBeLessThan(
      fake.send.mock.invocationCallOrder[revisionOneSendIndex]!,
    );
  });

  it("publishes one host-handled result before acknowledging and never reruns a redelivered input", async () => {
    const fake = transport();
    const delivery = {
      deliveryId: "delivery-input-result-test",
      sourceSessionId: "session-renderer-test",
      ...relayTiming,
      message: {
        protocolVersion: 1 as const,
        messageType: "input" as const,
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        revision: 0,
        requestId: "request-select-result",
        inputType: "select" as const,
        payload: { componentId: null },
      },
    };
    let deliveryAcknowledged = false;
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => {
      if (acknowledged.includes(delivery.deliveryId)) deliveryAcknowledged = true;
      return deliveryAcknowledged ? [] : [delivery];
    });
    const onSelect = vi.fn();
    render(<XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={onSelect}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR one-time pairing link" });
    await waitFor(() => expect(fake.send).toHaveBeenCalledWith(expect.objectContaining({
      messageType: "ephemeral",
      channel: "input.result",
      payload: expect.objectContaining({
        inputRequestId: "request-select-result",
        status: "handled",
        code: "selected",
      }),
    })));
    await waitFor(() => expect(fake.poll).toHaveBeenCalledWith([delivery.deliveryId]));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("binds protected panel confirmation to the exact authenticated renderer source", async () => {
    const fake = transport();
    const action = {
      type: "invoke_component_action",
      targetComponentId: "button",
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: 0,
      confirmation: "required",
    } as const;
    const deliveries: readonly XrAuthorityPollDelivery[] = [
      {
        deliveryId: "delivery-panel-active-presence",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1,
          messageType: "ephemeral",
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: 0,
          requestId: "request-panel-active-presence",
          channel: "xr.session.presence",
          sequence: 1,
          payload: {
            phase: "active",
            sourceSessionId: "session-renderer-test",
            sourcePairingId: "pairing-headset-test",
            serverReceivedAtMs: Date.now(),
          },
        },
      },
      {
        deliveryId: "delivery-panel-other-renderer",
        sourceSessionId: "session-other-renderer",
        ...relayTiming,
        message: {
          protocolVersion: 1,
          messageType: "input",
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: 0,
          requestId: "request-panel-other-renderer",
          inputType: "panel_action",
          payload: { panelId: "panel-button", action },
        },
      },
      {
        deliveryId: "delivery-panel-challenge",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1,
          messageType: "input",
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: 0,
          requestId: "request-panel-challenge",
          inputType: "panel_action",
          payload: { panelId: "panel-button", action },
        },
      },
      {
        deliveryId: "delivery-panel-confirmed",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1,
          messageType: "input",
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: 0,
          requestId: "request-panel-confirmed",
          inputType: "panel_action",
          payload: {
            panelId: "panel-button",
            action,
            confirmation: { challengeId: "challenge-pinned-renderer", decision: "confirmed" },
          },
        },
      },
    ];
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => (
      deliveries.filter((delivery) => !acknowledged.includes(delivery.deliveryId))
    ));
    const onPanelAction = vi.fn();
    const authorizePanelAction = vi.fn(() => true);
    render(<XRHeadsetSessionButton
      snapshot={interactiveSnapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      challengeIdFactory={() => "challenge-pinned-renderer"}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={onPanelAction}
      authorizePanelAction={authorizePanelAction}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));

    await waitFor(() => expect(onPanelAction).toHaveBeenCalledOnce());
    expect(authorizePanelAction).toHaveBeenCalledOnce();
    const results = fake.send.mock.calls
      .map(([message]) => message)
      .flatMap((message) => message.messageType === "ephemeral" && message.channel === "input.result"
        ? [message.payload]
        : []);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputRequestId: "request-panel-other-renderer", code: "confirmation_denied" }),
      expect.objectContaining({ inputRequestId: "request-panel-challenge", code: "confirmation_required" }),
      expect.objectContaining({ inputRequestId: "request-panel-confirmed", code: "panel_action_invoked" }),
    ]));
  });

  it("forwards voice only from the exact renderer pinned by authenticated presence", async () => {
    const fake = transport();
    const context = createXRContextEnvelope({
      source: "immersive-xr",
      workspaceId: snapshot.workspaceId,
      workspaceRevision: 0,
      capturedAtMs: 1_000,
      referenceSpace: "local-floor",
      headPose: {
        position: { x: 0, y: 1.7, z: 1 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
      trackedInputs: [],
      playerCapsule: { feet: { x: 0, y: 0, z: 1 }, radius: 0.25, height: 1.7 },
    });
    const voiceMessage = (requestId: string) => ({
      protocolVersion: 1 as const,
      messageType: "input" as const,
      sessionId: "session-authority-test",
      authorityEpoch: "epoch-authority-test",
      workspaceId: snapshot.workspaceId,
      revision: 0,
      requestId,
      inputType: "voice_final" as const,
      payload: {
        utteranceId: `utterance-${requestId}`,
        text: "Build a blue table here",
        sequence: 1,
        context,
      },
    });
    const deliveries: readonly XrAuthorityPollDelivery[] = [
      {
        deliveryId: "delivery-voice-active-presence",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1,
          messageType: "ephemeral",
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: 0,
          requestId: "request-voice-active-presence",
          channel: "xr.session.presence",
          sequence: 1,
          payload: {
            phase: "active",
            sourceSessionId: "session-renderer-test",
            sourcePairingId: "pairing-headset-test",
            serverReceivedAtMs: Date.now(),
          },
        },
      },
      {
        deliveryId: "delivery-voice-other-renderer",
        sourceSessionId: "session-other-renderer",
        ...relayTiming,
        message: voiceMessage("request-voice-other-renderer"),
      },
      {
        deliveryId: "delivery-voice-pinned-renderer",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: voiceMessage("request-voice-pinned-renderer"),
      },
    ];
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => (
      deliveries.filter((delivery) => !acknowledged.includes(delivery.deliveryId))
    ));
    const onVoiceIntent = vi.fn();
    render(<XRHeadsetSessionButton
      snapshot={interactiveSnapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
      onVoiceIntent={onVoiceIntent}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));

    await waitFor(() => expect(onVoiceIntent).toHaveBeenCalledOnce());
    expect(onVoiceIntent).toHaveBeenCalledWith(expect.objectContaining({
      text: "Build a blue table here",
      workspaceRevision: 0,
    }));
    const results = fake.send.mock.calls
      .map(([message]) => message)
      .flatMap((message) => message.messageType === "ephemeral" && message.channel === "input.result"
        ? [message.payload]
        : []);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputRequestId: "request-voice-other-renderer", code: "invalid_payload" }),
      expect.objectContaining({ inputRequestId: "request-voice-pinned-renderer", code: "voice_intent_forwarded" }),
    ]));
  });

  it("accepts only revision-bound live pose context from the paired renderer", async () => {
    const fake = transport();
    const context = createXRContextEnvelope({
      source: "immersive-xr",
      workspaceId: snapshot.workspaceId,
      workspaceRevision: snapshot.revision,
      capturedAtMs: 1_000,
      referenceSpace: "local-floor",
      headPose: {
        position: { x: 1, y: 1.7, z: 2 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
      trackedInputs: [],
      spatialPin: {
        pinId: "xr-pin-1",
        pinSequence: 1,
        workspacePositionM: { x: 1.25, y: 0, z: -2.5 },
        surfaceNormal: { x: 0, y: 1, z: 0 },
        hitKind: "ground",
        sourceId: "input-1-right",
        handedness: "right",
        placedAtMs: 900,
        placedAtWorkspaceRevision: snapshot.revision,
        coordinateSpace: "workspace-world-rub",
        units: "metre",
        authority: "render-interaction-estimate",
      },
      playerCapsule: { feet: { x: 1, y: 0, z: 2 }, radius: 0.25, height: 1.7 },
    });
    const deliveries: readonly XrAuthorityPollDelivery[] = [
      {
        deliveryId: "delivery-active-presence",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1 as const,
          messageType: "ephemeral" as const,
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: snapshot.revision,
          requestId: "request-active-presence",
          channel: "xr.session.presence",
          sequence: 1,
          payload: {
            phase: "active",
            sourceSessionId: "session-renderer-test",
            sourcePairingId: "pairing-headset-test",
            serverReceivedAtMs: Date.now(),
          },
        },
      },
      {
        deliveryId: "delivery-unpinned-pose",
        sourceSessionId: "session-other-renderer",
        ...relayTiming,
        message: {
          protocolVersion: 1 as const,
          messageType: "input" as const,
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: snapshot.revision,
          requestId: "request-unpinned-pose",
          inputType: "pose" as const,
          payload: { context },
        },
      },
      {
        deliveryId: "delivery-live-pose",
        sourceSessionId: "session-renderer-test",
        serverReceivedAtMs: 2_000,
        serverQueueAgeMs: 375,
        message: {
          protocolVersion: 1 as const,
          messageType: "input" as const,
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: snapshot.revision,
          requestId: "request-live-pose",
          inputType: "pose" as const,
          payload: { context },
        },
      },
      {
        deliveryId: "delivery-simulated-pose",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1 as const,
          messageType: "input" as const,
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: snapshot.revision,
          requestId: "request-simulated-pose",
          inputType: "pose" as const,
          payload: { context: { ...context, source: "desktop-simulator" as const } },
        },
      },
      {
        deliveryId: "delivery-stale-pose",
        sourceSessionId: "session-renderer-test",
        ...relayTiming,
        message: {
          protocolVersion: 1 as const,
          messageType: "input" as const,
          sessionId: "session-authority-test",
          authorityEpoch: "epoch-authority-test",
          workspaceId: snapshot.workspaceId,
          revision: snapshot.revision,
          requestId: "request-stale-pose",
          inputType: "pose" as const,
          payload: { context: { ...context, workspaceRevision: snapshot.revision + 1 } },
        },
      },
    ];
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => (
      deliveries.filter((delivery) => !acknowledged.includes(delivery.deliveryId))
    ));
    const onSpatialContext = vi.fn();
    const onPhaseChange = vi.fn();
    render(<XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={vi.fn()}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
      onSpatialContext={onSpatialContext}
      onPhaseChange={onPhaseChange}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));

    await waitFor(() => expect(onSpatialContext).toHaveBeenCalledWith(context, {
      rendererSessionId: "session-renderer-test",
      serverReceivedAtMs: 2_000,
      serverQueueAgeMs: 375,
    }));
    expect(onSpatialContext).toHaveBeenCalledOnce();
    await waitFor(() => expect(onPhaseChange).toHaveBeenCalledWith(
      "active",
      "Headset paired · immersive XR is active.",
    ));
    expect(fake.send.mock.calls.some(([message]) => (
      message.messageType === "ephemeral"
      && message.channel === "input.result"
      && message.payload.inputType === "pose"
    ))).toBe(false);
  });

  it("converges a lost result ACK with the exact envelope and does not rerun the host action", async () => {
    const fake = transport();
    const delivery = {
      deliveryId: "delivery-input-result-lost-ack",
      sourceSessionId: "session-renderer-test",
      ...relayTiming,
      message: {
        protocolVersion: 1 as const,
        messageType: "input" as const,
        sessionId: "session-authority-test",
        authorityEpoch: "epoch-authority-test",
        workspaceId: snapshot.workspaceId,
        revision: 0,
        requestId: "request-select-lost-ack",
        inputType: "select" as const,
        payload: { componentId: null },
      },
    };
    let deliveryAcknowledged = false;
    fake.poll.mockImplementation(async (acknowledged: readonly string[] = []) => {
      if (acknowledged.includes(delivery.deliveryId)) deliveryAcknowledged = true;
      return deliveryAcknowledged ? [] : [delivery];
    });
    let dropResultAck = true;
    fake.send.mockImplementation(async (message: XrRoutableMessage) => {
      if (message.messageType === "ephemeral" && message.channel === "input.result" && dropResultAck) {
        dropResultAck = false;
        throw Object.assign(new Error("The committed result ACK was lost."), { retryable: true });
      }
      return {
        ...message,
        messageType: "ack" as const,
        status: "accepted" as const,
      };
    });
    const onSelect = vi.fn();
    render(<XRHeadsetSessionButton
      snapshot={snapshot}
      registryIdentity="registry:test"
      viewerUrl="https://viewer.semaframe.test/xr.html"
      transportFactory={() => fake}
      pollIntervalMs={1}
      onSelect={onSelect}
      onActivate={vi.fn()}
      onPanelAction={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Connect XR headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start headset session" }));
    await screen.findByRole("textbox", { name: "XR one-time pairing link" });
    await waitFor(() => expect(fake.poll).toHaveBeenCalledWith([delivery.deliveryId]));

    const attempts = fake.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.messageType === "ephemeral" && message.channel === "input.result");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
