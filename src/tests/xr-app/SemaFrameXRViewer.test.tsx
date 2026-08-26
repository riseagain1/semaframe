import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  diffXrWorkspaceProjection,
  digestXrProjection,
  toXrWorkspaceProjection,
  xrProjectionAsJsonObject,
} from "../../xr/authority";
import {
  SemaFrameXRViewer,
  XR_USER_STATE_PUBLISH_INTERVAL_MS,
  type XrViewerRendererCallbacks,
  type XrViewerRendererPort,
  type XrViewerSpeechOutputPort,
  type XrViewerSpeechPort,
  type XrViewerVoiceCuePort,
  type XrViewerTransportPort,
  type XrViewerTransportSession,
  type XrViewerWebXRRuntimePort,
} from "../../xr/app";
import {
  XR_RELAY_PROTOCOL_VERSION,
  type XrDeltaMessage,
  type XrEphemeralMessage,
  type XrInputMessage,
  type XrSnapshotMessage,
} from "../../xr/protocol";
import type { XRSpatialContextSnapshot } from "../../xr/client";
import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_POLICY_VERSION,
  type UltraLocalBenchmarkRequest,
  type UltraLocalEvidencePort,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
} from "../../xr/ultra";
import type {
  VoiceRelayReplySnapshot,
  VoiceRelayRuntimePort,
  VoiceRelayStatus,
} from "../../voice-relay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const identity = {
  sessionId: "viewer-session-0001",
  authorityEpoch: "authority-epoch-0001",
  workspaceId: "workspace-viewer-app",
} as const;

function workspace(revision = 7): WorkspaceRenderSnapshot {
  return {
    workspaceId: identity.workspaceId,
    revision,
    components: [
      {
        id: "machine",
        type: { typeId: "spatial-entity", version: "1.0.0", digest: "fixture" },
        label: "Machine",
        props: { assetId: "primitive_box", entityKind: "primitive" },
        durableState: {},
        placement: {
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        tags: [],
        visibility: "visible",
        locks: { placement: false },
      },
      {
        id: "start-button",
        type: { typeId: "button", version: "1.0.0", digest: "fixture" },
        label: "Start machine",
        props: { label: "Start machine", variant: "primary" },
        durableState: { pressCount: 0 },
        placement: {
          space: "viewport",
          anchor: "bottom_right",
          offset: { x: -20, y: -20 },
        },
        tags: [],
        visibility: "visible",
        locks: { placement: false },
      },
    ],
  };
}

async function snapshotMessage(revision = 7): Promise<XrSnapshotMessage> {
  const projection = toXrWorkspaceProjection(workspace(revision));
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "snapshot",
    ...identity,
    revision,
    requestId: `snapshot-viewer-${revision}`,
    registryDigest: `sha256:${"a".repeat(64)}`,
    snapshotDigest: await digestXrProjection(projection),
    snapshot: xrProjectionAsJsonObject(projection),
  };
}

async function deltaMessage(beforeRevision = 7): Promise<XrDeltaMessage> {
  const before = toXrWorkspaceProjection(workspace(beforeRevision));
  const baseAfter = workspace(beforeRevision + 1);
  const template = baseAfter.components[0]!;
  const afterWorkspace: WorkspaceRenderSnapshot = {
    ...baseAfter,
    components: [
      ...baseAfter.components,
      {
        ...template,
        id: "new-live-part",
        label: "New live part",
        placement: {
          space: "world3d",
          position: { x: 2, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    ],
  };
  const after = toXrWorkspaceProjection(afterWorkspace);
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "delta",
    ...identity,
    revision: after.revision,
    requestId: `delta-viewer-${after.revision}`,
    baseRevision: before.revision,
    baseSnapshotDigest: await digestXrProjection(before),
    snapshotDigest: await digestXrProjection(after),
    delta: xrProjectionAsJsonObject(diffXrWorkspaceProjection(before, after)),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type ViewerXRSessionFixture = Awaited<ReturnType<XrViewerWebXRRuntimePort["requestSession"]>>;

class FakeRenderer implements XrViewerRendererPort {
  callbacks?: XrViewerRendererCallbacks;
  readonly initialize = vi.fn(async () => undefined);
  readonly render = vi.fn(async () => undefined);
  readonly enterXR = vi.fn(async () => undefined);
  readonly exitXR = vi.fn(async (): Promise<void> => undefined);
  readonly isXRPresenting = vi.fn(() => false);
  readonly setXRWorldPanels = vi.fn(() => undefined);
  readonly setXRVoiceFeedback = vi.fn(() => undefined);
  readonly pulseXRVoiceHaptics = vi.fn(() => undefined);
  readonly captureXRSpatialContext = vi.fn<() => XRSpatialContextSnapshot>(() => ({
    sampleSequence: 1,
    tracking: {
      state: "tracked",
      headPoseState: "tracked",
      sourceTimestampMs: 100,
      sourceTimestampBasis: "performance-time-origin",
      sourceAgeMs: 5,
      sessionVisibility: "visible",
    },
    referenceSpace: "local-floor" as const,
    headPose: {
      position: { x: 1, y: 1.7, z: 2 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    trackedInputs: [],
    playerCapsule: { feet: { x: 1, y: 0, z: 2 }, radius: 0.3, height: 1.7 },
  }));
  readonly dispose = vi.fn(() => undefined);
}

class FakeTransport implements XrViewerTransportPort {
  request?: Parameters<XrViewerTransportPort["pair"]>[0];
  readonly sent: XrInputMessage[] = [];
  readonly session: XrViewerTransportSession = {
    identity,
    send: vi.fn(async (message: XrInputMessage) => { this.sent.push(message); }),
    publishPresence: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  readonly pair = vi.fn(async (request: Parameters<XrViewerTransportPort["pair"]>[0]) => {
    this.request = request;
    return this.session;
  });

  async publishSnapshot(revision = 7) {
    const message = await snapshotMessage(revision);
    await act(async () => {
      this.request?.onMessage(message);
      await Promise.resolve();
    });
  }

  async publishDelta(beforeRevision = 7) {
    const message = await deltaMessage(beforeRevision);
    await act(async () => {
      await this.request?.onMessage(message);
      await Promise.resolve();
    });
  }

  async publishInputResult(input: XrInputMessage, result: Readonly<{
    status: "handled" | "ignored" | "rejected";
    code: string;
    message?: string;
    confirmationChallenge?: Readonly<{
      challengeId: string;
      expiresInMs: number;
      panelId: string;
      actionLabel: string;
      targetComponentId: string;
      workspaceRevision: number;
    }>;
  }>) {
    const message: XrEphemeralMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      ...identity,
      revision: input.revision,
      requestId: `result-${input.requestId}`,
      channel: "input.result",
      sequence: 1,
      payload: {
        inputRequestId: input.requestId,
        inputType: input.inputType,
        workspaceRevision: input.revision,
        status: result.status,
        code: result.code,
        ...(typeof input.payload.utteranceId === "string" ? { utteranceId: input.payload.utteranceId } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.confirmationChallenge ? { confirmationChallenge: result.confirmationChallenge } : {}),
      },
    };
    await act(async () => {
      await this.request?.onMessage(message);
    });
  }
}

const relayTarget = Object.freeze({
  targetId: "target-codex",
  label: "Codex · SemaFrame",
  capabilities: Object.freeze({
    draftInsertion: true,
    explicitSend: true,
    replyObservation: true,
  }),
});

class FakeVoiceRelay implements VoiceRelayRuntimePort {
  status: VoiceRelayStatus = Object.freeze({
    enabled: true,
    armed: true,
    phase: "ready",
    target: relayTarget,
  });
  replies: VoiceRelayReplySnapshot[] = [{
    stageId: "relay-stage-1",
    phase: "complete",
    sequence: 1,
    text: "The Agent completed the requested scene.",
  }];
  readonly inspect = vi.fn(async () => this.status);
  readonly stage = vi.fn(async () => ({
    stageId: "relay-stage-1",
    target: relayTarget,
    expiresAtMs: Date.now() + 60_000,
    status: "awaiting_confirmation" as const,
  }));
  readonly confirm = vi.fn(async () => ({
    stageId: "relay-stage-1",
    status: "sent" as const,
    observationAvailable: true,
  }));
  readonly cancel = vi.fn(async () => ({
    stageId: "relay-stage-1",
    status: "cancelled" as const,
  }));
  readonly readReply = vi.fn(async () => this.replies.shift() ?? ({
    stageId: "relay-stage-1",
    phase: "waiting" as const,
    sequence: 1,
  }));
}

function viewer(input: Readonly<{
  transport?: FakeTransport;
  renderer?: FakeRenderer;
  runtime?: XrViewerWebXRRuntimePort;
  speech?: XrViewerSpeechPort;
  voiceRelay?: VoiceRelayRuntimePort;
  speechOutput?: XrViewerSpeechOutputPort;
  voiceCues?: XrViewerVoiceCuePort;
  readRepliesAloud?: boolean;
  token?: string;
  scrub?: () => void;
  onPanels?: (panels: readonly unknown[]) => void;
}> = {}) {
  const transport = input.transport ?? new FakeTransport();
  const renderer = input.renderer ?? new FakeRenderer();
  const rendererFactory = (callbacks: XrViewerRendererCallbacks) => {
    renderer.callbacks = callbacks;
    return renderer;
  };
  const scrub = input.scrub ?? vi.fn();
  const result = render(<SemaFrameXRViewer
    transport={transport}
    initialPairingToken={input.token ?? "T".repeat(43)}
    scrubPairingToken={scrub}
    rendererFactory={rendererFactory}
    {...(input.runtime ? { webXRRuntime: input.runtime } : {})}
    {...(input.speech ? { speech: input.speech } : {})}
    {...(input.voiceRelay ? { voiceRelay: input.voiceRelay } : {})}
    {...(input.speechOutput ? { speechOutput: input.speechOutput } : {})}
    {...(input.voiceCues ? { voiceCues: input.voiceCues } : {})}
    readVoiceRelayRepliesAloud={input.readRepliesAloud ?? false}
    {...(input.onPanels ? { onWorldPanelsChanged: input.onPanels } : {})}
    requestIdFactory={() => "viewer-request-0001"}
  />);
  return { ...result, transport, renderer, scrub };
}

describe("SemaFrameXRViewer", () => {
  it("publishes Agent-readable XR user state at the bounded four-hertz cadence", () => {
    expect(XR_USER_STATE_PUBLISH_INTERVAL_MS).toBe(250);
  });

  it("consumes a one-time token only after synchronous URL scrubbing and never persists or renders it", async () => {
    const order: string[] = [];
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const transport = new FakeTransport();
    transport.pair.mockImplementation(async (request) => {
      order.push("pair");
      transport.request = request;
      return transport.session;
    });
    const secret = "S".repeat(43);
    viewer({
      transport,
      token: secret,
      scrub: () => { order.push("scrub"); },
    });

    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    expect(order).toEqual(["scrub", "pair"]);
    expect(transport.pair.mock.calls[0]?.[0].pairingToken).toBe(secret);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(localSet).not.toHaveBeenCalled();
    expect(await screen.findByText(/Connected\. Waiting for the authoritative snapshot/i)).toBeVisible();
  });

  it("installs the bundled session-scoped Windows Ultra evidence only after secure pairing", async () => {
    const transport = new FakeTransport();
    const evidence: UltraLocalEvidencePort = {
      collectStaticProbe: vi.fn(async (): Promise<UltraStaticProbe> => ({
        version: 1,
        policyVersion: ULTRA_POLICY_VERSION,
        platform: "windows",
        architecture: "x64",
        operatingSystemVersion: "10.0.26100",
        logicalProcessorCount: 24,
        systemMemoryBytes: 32 * 1024 * 1024 * 1024,
        graphics: {
          adapterFingerprint: `sha256:${"a".repeat(64)}`,
          driverVersion: "32.0.15.9000",
          hardwareAccelerated: true,
          supportedByRuntime: true,
        },
        runtime: {
          kind: "meta_horizon_link",
          version: "1.100.0",
          openXrActive: true,
        },
        webXr: {
          browserEngine: "chromium",
          secureContext: true,
          immersiveVrSupported: true,
        },
        collectedAt: new Date().toISOString(),
      })),
      runPhysicalBenchmark: vi.fn(async (
        request: UltraLocalBenchmarkRequest,
      ): Promise<UltraRuntimeBenchmarkInput> => ({
        version: 1,
        policyVersion: ULTRA_POLICY_VERSION,
        workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
        transport: "link_cable",
        targetFrameRateHz: request.targetFrameRateHz,
        durationMs: request.minimumDurationMs,
        frameTimeSamplesMs: Array.from({ length: 5_400 }, () => 11),
        droppedFrameCount: 0,
        maximumConsecutiveDroppedFrames: 0,
        processRssSamplesBytes: Array.from({ length: 11 }, () => 2 * 1024 * 1024 * 1024),
        gpuMemoryUsageRatioSamples: Array.from({ length: 11 }, () => 0.5),
        gpuMemoryHeadroomSamplesBytes: Array.from({ length: 11 }, () => 4 * 1024 * 1024 * 1024),
        thermalThrottleObserved: false,
        runtimeDisconnectCount: 0,
        completedAt: new Date().toISOString(),
      })),
    };
    Object.assign(transport.session, { ultraEvidence: evidence });

    viewer({ transport });
    expect(screen.queryByRole("button", { name: "Check Ultra" })).not.toBeInTheDocument();
    const check = await screen.findByRole("button", { name: "Check Ultra" });
    expect(check).toHaveAttribute("data-xr-ultra-phase", "unprobed");
    expect(evidence.collectStaticProbe).not.toHaveBeenCalled();
    await userEvent.click(check);
    await waitFor(() => expect(evidence.collectStaticProbe).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Start Ultra benchmark" })).toHaveAttribute(
      "data-xr-ultra-phase",
      "available",
    );
  });

  it("clears a manually entered secret before pairing and redacts transport errors that echo it", async () => {
    const transport = new FakeTransport();
    transport.pair.mockImplementation(async ({ pairingCode }) => {
      throw new Error(`Rejected code ${pairingCode}`);
    });
    render(<SemaFrameXRViewer
      transport={transport}
      scrubPairingToken={() => undefined}
      rendererFactory={() => new FakeRenderer()}
      requestIdFactory={() => "viewer-request-0001"}
    />);
    const secret = "123456";
    const input = screen.getByLabelText(/One-time pairing code/i);
    await userEvent.type(input, secret);
    await userEvent.click(screen.getByRole("button", { name: /Pair once/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(input).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("[pairing secret]");
    expect(screen.getByRole("alert")).not.toHaveTextContent(secret);
  });

  it("renders only authoritative snapshots and emits selection, activation, and panel actions at that revision", async () => {
    const onPanels = vi.fn();
    const { transport, renderer } = viewer({ onPanels });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Loading authoritative Workspace snapshot/i)).toBeVisible();
    await transport.publishSnapshot(7);
    await waitFor(() => expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7 }),
      [],
      { delivery: "initial" },
    ));
    expect(onPanels).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ rendererNeutral: true, workspaceRevision: 7 }),
    ]));
    expect(renderer.setXRWorldPanels).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ rendererNeutral: true, workspaceRevision: 7 }),
    ]), 7);

    act(() => renderer.callbacks?.onSelect("machine"));
    act(() => renderer.callbacks?.onActivate("machine"));
    await userEvent.click(await screen.findByRole("button", { name: "Start machine" }));
    await waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(transport.sent.map(({ inputType }) => inputType)).toEqual(["select", "activate", "panel_action"]);
    expect(transport.sent.every(({ revision }) => revision === 7)).toBe(true);
    expect(transport.sent[2]).toMatchObject({
      payload: {
        panelId: "xr-panel:start-button",
        action: { targetComponentId: "start-button", actionName: "press", expectedWorkspaceRevision: 7 },
      },
    });
  });

  it("classifies an authoritative live delta as one stable materialization batch", async () => {
    const { transport, renderer } = viewer();
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7 }),
      [],
      { delivery: "initial" },
    ));
    renderer.render.mockClear();

    await transport.publishDelta(7);
    await waitFor(() => expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 8 }),
      [],
      {
        delivery: "live_commit",
        batchKey: "authority-epoch-0001:delta-viewer-8:8",
      },
    ));
  });

  it("retains an ambiguously committed action until its reliable result arrives", async () => {
    const transport = new FakeTransport();
    vi.mocked(transport.session.send).mockImplementation(async (message: XrInputMessage) => {
      transport.sent.push(message);
      throw Object.assign(new Error("Both HTTP acknowledgements were lost."), { retryable: true });
    });
    const { renderer } = viewer({ transport });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7 }),
      [],
      { delivery: "initial" },
    ));
    await waitFor(() => expect(screen.getByText("connected")).toBeVisible());
    expect(screen.getByText(/Live Workspace · revision 7/i)).toBeVisible();

    act(() => renderer.callbacks?.onActivate("machine"));
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Both HTTP acknowledgements were lost.");

    await transport.publishInputResult(transport.sent[0]!, {
      status: "handled",
      code: "activated",
      message: "The machine started once.",
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("The machine started once.");
  });

  it("routes immersive CanvasTexture panel actions through the same revision-bound authority input", async () => {
    const { transport, renderer } = viewer();
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(renderer.setXRWorldPanels).toHaveBeenCalled());

    act(() => renderer.callbacks?.onPanelAction({
      panelId: "xr-panel:start-button",
      componentId: "start-button",
      workspaceRevision: 7,
      action: {
        type: "invoke_component_action",
        targetComponentId: "start-button",
        actionName: "press",
        input: {},
        expectedWorkspaceRevision: 7,
        confirmation: "none",
      },
    }));
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]).toMatchObject({
      inputType: "panel_action",
      revision: 7,
      payload: { panelId: "xr-panel:start-button" },
    });

    act(() => renderer.callbacks?.onPanelWarning({
      code: "panel_limit",
      message: "Panel projection was bounded.",
    }));
    expect(screen.getByRole("status")).toHaveTextContent("XR panel warning · Panel projection was bounded.");
  });

  it("renders and consumes a host-issued one-use confirmation inside the XR world", async () => {
    const { transport, renderer } = viewer();
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(renderer.setXRWorldPanels).toHaveBeenCalledWith(
      expect.any(Array),
      7,
    ));
    const protectedAction = {
      type: "invoke_component_action" as const,
      targetComponentId: "start-button",
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: 7,
      confirmation: "required" as const,
    };
    act(() => renderer.callbacks?.onPanelAction({
      panelId: "xr-panel:start-button",
      componentId: "start-button",
      workspaceRevision: 7,
      action: protectedAction,
    }));
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]!.payload).not.toHaveProperty("confirmation");

    await transport.publishInputResult(transport.sent[0]!, {
      status: "ignored",
      code: "confirmation_required",
      confirmationChallenge: {
        challengeId: "challenge-viewer-0001",
        expiresInMs: 15_000,
        panelId: "xr-panel:start-button",
        actionLabel: "press",
        targetComponentId: "start-button",
        workspaceRevision: 7,
      },
    });

    expect(await screen.findByText(/Confirm Workspace action/i)).toBeVisible();
    expect(renderer.setXRWorldPanels).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        sourcePlacementSpace: "viewer-confirmation",
        panel: expect.objectContaining({ panelId: "xr-confirmation:challenge-viewer-0001:confirm" }),
      }),
    ]), 7);
    await userEvent.click(screen.getByRole("button", { name: "Confirm once" }));
    await waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[1]).toMatchObject({
      inputType: "panel_action",
      payload: {
        panelId: "xr-panel:start-button",
        action: protectedAction,
        confirmation: { challengeId: "challenge-viewer-0001", decision: "confirmed" },
      },
    });
    expect(screen.queryByText(/Confirm Workspace action/i)).not.toBeInTheDocument();
  });

  it("shows a reconnect state and resumes from an exact revision cursor without reusing the pairing token", async () => {
    const { transport } = viewer();
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(screen.getByText(/revision 7/i)).toBeVisible());
    act(() => transport.request?.onDisconnected({ reason: "wifi unavailable", retryable: true }));
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(transport.session.reconnect).toHaveBeenCalledOnce());
    expect(transport.session.reconnect).toHaveBeenCalledWith(expect.objectContaining({
      ...identity,
      revision: 7,
      requestId: "viewer-request-0001",
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(transport.pair).toHaveBeenCalledOnce();
  });

  it("flushes an ended transition after reconnect when WebXR ends during a transient outage", async () => {
    const ended = new Set<(reason: string) => void>();
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-disconnected-end",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession: {} as XRSession,
        end: vi.fn(async () => undefined),
        onEnded: (listener: (reason: string) => void) => {
          ended.add(listener);
          return () => { ended.delete(listener); };
        },
      })),
    };
    const { transport, renderer } = viewer({ runtime });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await screen.findByRole("button", { name: "Exit XR" });

    act(() => transport.request?.onDisconnected({ reason: "wifi unavailable", retryable: true }));
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeVisible();
    await act(async () => {
      for (const listener of [...ended]) listener("runtime ended while offline");
      await Promise.resolve();
    });
    await waitFor(() => expect(renderer.exitXR).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Exiting XR…" })).toBeDisabled();
    expect(transport.session.publishPresence).not.toHaveBeenCalledWith("ended", 7);

    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(transport.session.publishPresence).toHaveBeenCalledWith("ended", 7));
    await screen.findByRole("button", { name: "Enter XR" });
    const phases = vi.mocked(transport.session.publishPresence!).mock.calls.map(([phase]) => phase);
    expect(phases.slice(-2)).toEqual(["ended", "replica_ready"]);
  });

  it("returns a non-retryable expired epoch to pairing and accepts a fresh session without a reload", async () => {
    const transport = new FakeTransport();
    const requests: Array<Parameters<XrViewerTransportPort["pair"]>[0]> = [];
    const firstSession = transport.session;
    const nextIdentity = {
      ...identity,
      sessionId: "viewer-session-0002",
      authorityEpoch: "authority-epoch-0002",
    } as const;
    const secondSession: XrViewerTransportSession = {
      identity: nextIdentity,
      send: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    transport.pair.mockImplementation(async (request) => {
      requests.push(request);
      transport.request = request;
      return requests.length === 1 ? firstSession : secondSession;
    });
    viewer({ transport });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(screen.getByText(/revision 7/i)).toBeVisible());

    act(() => requests[0]?.onDisconnected({
      reason: "authority epoch expired",
      retryable: false,
    }));
    expect(await screen.findByRole("heading", { name: /Connect this renderer/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    expect(firstSession.close).toHaveBeenCalledWith("fresh_pairing_required");

    const freshCode = "654321";
    await userEvent.type(screen.getByLabelText(/One-time pairing code/i), freshCode);
    await userEvent.click(screen.getByRole("button", { name: /Pair once/i }));
    await waitFor(() => expect(transport.pair).toHaveBeenCalledTimes(2));
    expect(transport.pair.mock.calls[1]?.[0].pairingCode).toBe(freshCode);

    const freshSnapshot = { ...(await snapshotMessage(9)), ...nextIdentity };
    await act(async () => {
      await requests[1]?.onMessage(freshSnapshot);
    });
    expect(await screen.findByText(/revision 9/i)).toBeVisible();
    expect(screen.getByText("connected")).toBeVisible();
  });

  it("probes WebXR without starting it and requests immersive mode only from the Enter XR button", async () => {
    const ended = new Set<(reason: string) => void>();
    const rawSession = {} as XRSession;
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-0001",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession,
        end: vi.fn(async () => undefined),
        onEnded: (listener: (reason: string) => void) => {
          ended.add(listener);
          return () => { ended.delete(listener); };
        },
      })),
    };
    const { transport, renderer } = viewer({ runtime });
    await waitFor(() => expect(runtime.probe).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Enter XR" })).toBeEnabled());
    expect(runtime.requestSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Enter XR" }));
    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledOnce());
    expect(renderer.enterXR).toHaveBeenCalledWith(rawSession, {
      referenceSpaceType: "local-floor",
      framebufferScaleFactor: 0.82,
      foveation: 0.65,
      targetFrameRateHz: 72,
      teleport: true,
    });
    expect(screen.getByRole("button", { name: "Exit XR" })).toBeVisible();
    expect(screen.queryByText(/Desktop simulator · Non-immersive/i)).not.toBeInTheDocument();
    expect(transport.pair).toHaveBeenCalledOnce();
  });

  it("publishes a replaced spatial pin immediately instead of waiting for the pose heartbeat", async () => {
    const rawSession = {} as XRSession;
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-pin",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession,
        end: vi.fn(async () => undefined),
        onEnded: () => () => undefined,
      })),
    };
    const { transport, renderer } = viewer({ runtime });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit XR" })).toBeVisible());
    transport.sent.length = 0;
    const placedAtMs = Date.now();
    renderer.captureXRSpatialContext.mockReturnValue({
      sampleSequence: 2,
      tracking: {
        state: "tracked",
        headPoseState: "tracked",
        sourceTimestampMs: 200,
        sourceTimestampBasis: "performance-time-origin",
        sourceAgeMs: 4,
        sessionVisibility: "visible",
      },
      referenceSpace: "local-floor",
      headPose: {
        position: { x: 1, y: 1.7, z: 2 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
      trackedInputs: [],
      spatialPin: {
        pinId: "xr-pin-1",
        pinSequence: 1,
        workspacePositionM: { x: 1.25, y: 0.8, z: -2.5 },
        surfaceNormal: { x: 0, y: 1, z: 0 },
        hitKind: "ground",
        sourceId: "input-1-right",
        handedness: "right",
        placedAtMs,
        placedAtWorkspaceRevision: 7,
        coordinateSpace: "workspace-world-rub",
        units: "metre",
        authority: "render-interaction-estimate",
      },
      playerCapsule: { feet: { x: 1, y: 0, z: 2 }, radius: 0.3, height: 1.7 },
    });

    act(() => renderer.callbacks?.onSpatialPinChange({
      action: "placed",
      pin: renderer.captureXRSpatialContext().spatialPin,
    }));

    await waitFor(() => expect(transport.sent.some((message) => (
      message.inputType === "pose"
      && (message.payload.context as Record<string, unknown>)?.spatialPin !== undefined
    ))).toBe(true));
  });

  it("surfaces an authenticated desktop exit request inside the active immersive session", async () => {
    const rawSession = {} as XRSession;
    const end = vi.fn(async () => undefined);
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-remote-exit",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession,
        end,
        onEnded: () => () => undefined,
      })),
    };
    const renderer = new FakeRenderer();
    const { transport } = viewer({ runtime, renderer });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await screen.findByRole("button", { name: "Exit XR" });

    const control: XrEphemeralMessage = {
      protocolVersion: XR_RELAY_PROTOCOL_VERSION,
      messageType: "ephemeral",
      ...identity,
      revision: 7,
      requestId: "desktop-request-exit-xr-0001",
      channel: "xr.session.control",
      sequence: 1,
      payload: { action: "request_exit" },
    };
    await act(async () => {
      await transport.request?.onMessage(control);
    });

    expect(screen.getByRole("button", { name: "Exit XR · requested" }))
      .toHaveAttribute("data-xr-exit-requested", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The desktop Agent requested XR exit. Use the visible Exit XR control when ready.",
    );
    expect(renderer.setXRVoiceFeedback).toHaveBeenCalledWith({
      phase: "ready",
      message: "Exit XR requested",
      subtitle: "Use the headset Exit XR control when ready. The Workspace will remain open.",
    });
    expect(renderer.exitXR).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("serializes an active XR teardown before returning an expired authority epoch to pairing", async () => {
    const exitGate = deferred<void>();
    const end = vi.fn(async () => undefined);
    const rawSession = {} as XRSession;
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-expired",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession,
        end,
        onEnded: () => () => undefined,
      })),
    };
    const renderer = new FakeRenderer();
    renderer.exitXR.mockImplementation(async () => exitGate.promise);
    const { transport } = viewer({ runtime, renderer });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await screen.findByRole("button", { name: "Exit XR" });

    act(() => transport.request?.onDisconnected({
      reason: "authority epoch expired",
      retryable: false,
    }));
    await waitFor(() => expect(renderer.exitXR).toHaveBeenCalledOnce());
    expect(end).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /Connect this renderer/i })).not.toBeInTheDocument();
    expect(renderer.dispose).not.toHaveBeenCalled();

    await act(async () => exitGate.resolve());
    expect(await screen.findByRole("heading", { name: /Connect this renderer/i })).toBeVisible();
    await waitFor(() => expect(renderer.dispose).toHaveBeenCalledOnce());
    expect(end).not.toHaveBeenCalled();
  });

  it("shares one renderer-owned XR teardown between unmount cleanup paths", async () => {
    const exitGate = deferred<void>();
    const end = vi.fn(async () => undefined);
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-unmount",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession: {} as XRSession,
        end,
        onEnded: () => () => undefined,
      })),
    };
    const renderer = new FakeRenderer();
    renderer.exitXR.mockImplementation(async () => exitGate.promise);
    const view = viewer({ runtime, renderer });
    await waitFor(() => expect(view.transport.pair).toHaveBeenCalledOnce());
    await view.transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await screen.findByRole("button", { name: "Exit XR" });

    view.unmount();
    await waitFor(() => expect(renderer.exitXR).toHaveBeenCalledOnce());
    expect(end).not.toHaveBeenCalled();
    expect(renderer.dispose).not.toHaveBeenCalled();
    await act(async () => exitGate.resolve());
    await waitFor(() => expect(renderer.dispose).toHaveBeenCalledOnce());
    expect(renderer.exitXR).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });

  it("ends a granted but unattached XR session when authority expires during the permission request", async () => {
    const sessionGate = deferred<ViewerXRSessionFixture>();
    const end = vi.fn(async () => undefined);
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => sessionGate.promise),
    };
    const renderer = new FakeRenderer();
    const { transport } = viewer({ runtime, renderer });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledOnce());
    act(() => transport.request?.onDisconnected({
      reason: "authority epoch expired",
      retryable: false,
    }));

    sessionGate.resolve({
      id: "webxr-session-stale-request",
      mode: "immersive-vr",
      referenceSpace: "local-floor",
      rawSession: {} as XRSession,
      end,
      onEnded: () => () => undefined,
    });
    await waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(renderer.enterXR).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: /Connect this renderer/i })).toBeVisible();
  });

  it("exposes stable pairing and connected layout hooks for the 320px responsive shell", async () => {
    const transport = new FakeTransport();
    const renderer = new FakeRenderer();
    render(<SemaFrameXRViewer
      transport={transport}
      scrubPairingToken={() => undefined}
      rendererFactory={(callbacks) => {
        renderer.callbacks = callbacks;
        return renderer;
      }}
      requestIdFactory={() => "viewer-request-0001"}
    />);
    const pairing = screen.getByRole("heading", { name: /Connect this renderer/i }).closest("section");
    expect(pairing).toHaveAttribute("data-xr-layout", "pairing");
    expect(pairing).toHaveClass("xr-viewer-pairing");
    const pairingCode = screen.getByLabelText(/One-time pairing code/i);
    expect(pairingCode.parentElement).toHaveClass("xr-viewer-pairing-row");
    expect(pairingCode).toHaveAttribute("inputmode", "numeric");
    expect(pairingCode).toHaveAttribute("maxlength", "6");
    expect(pairingCode).toHaveAttribute("autocomplete", "one-time-code");

    await userEvent.type(pairingCode, "12ab34567");
    expect(pairingCode).toHaveValue("123456");
    await userEvent.click(screen.getByRole("button", { name: /Pair once/i }));
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    expect(transport.pair.mock.calls[0]?.[0]).toMatchObject({ pairingCode: "123456" });
    expect(transport.pair.mock.calls[0]?.[0]).not.toHaveProperty("pairingToken");
    expect(document.querySelector('[data-xr-layout="connected"]')).toHaveClass("xr-viewer-connected");
  });

  it("keeps a normal headset pairing renderer-only without a Voice Relay provider warning", async () => {
    const { transport, renderer } = viewer();
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    expect(await screen.findByText("Desktop simulator · Non-immersive")).toBeVisible();
    expect(screen.queryByText("Voice provider not configured")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Voice Relay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start push to talk/i })).not.toBeInTheDocument();
    expect(renderer.setXRVoiceFeedback).toHaveBeenLastCalledWith({ phase: "hidden" });
  });

  it("checks the headset speech provider only after standalone Voice Relay is explicitly granted", async () => {
    const relay = new FakeVoiceRelay();
    const { transport } = viewer({ voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    expect(await screen.findByRole("heading", { name: "Voice Relay" })).toBeVisible();
    expect(screen.getByText("Voice provider not configured")).toBeVisible();
    expect(screen.getByRole("button", { name: /Start push to talk/i })).toBeDisabled();
  });

  it("keeps Voice Relay feedback hidden throughout immersive XR when the pairing is renderer-only", async () => {
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-renderer-only",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession: {} as XRSession,
        end: vi.fn(async () => undefined),
        onEnded: () => () => undefined,
      })),
    };
    const { transport, renderer } = viewer({ runtime });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit XR" })).toBeVisible());

    expect(renderer.setXRVoiceFeedback).toHaveBeenLastCalledWith({ phase: "hidden" });
    expect(renderer.setXRVoiceFeedback).not.toHaveBeenCalledWith(expect.objectContaining({
      phase: "error",
      message: "Voice provider not configured",
    }));
  });

  it("keeps Voice Relay off by default and never starts the microphone while the relay is disabled", async () => {
    const relay = new FakeVoiceRelay();
    relay.status = Object.freeze({ enabled: false, armed: false, phase: "off" });
    const speech: XrViewerSpeechPort = { begin: vi.fn() };
    const { transport } = viewer({ speech, voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    expect(await screen.findByText(/Voice Relay is off\. Ask the Agent/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Start push to talk/i })).toBeDisabled();
    expect(speech.begin).not.toHaveBeenCalled();
  });

  it("does not require a headset speech provider until Voice Relay is explicitly armed", async () => {
    const relay = new FakeVoiceRelay();
    relay.status = Object.freeze({
      enabled: true,
      armed: false,
      phase: "ready",
      target: relayTarget,
    });
    const { transport, renderer } = viewer({ voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();

    expect(await screen.findByText(/Voice Relay is not armed for this session/i)).toBeVisible();
    expect(screen.queryByText("Voice provider not configured")).not.toBeInTheDocument();
    expect(renderer.setXRVoiceFeedback).toHaveBeenLastCalledWith({ phase: "hidden" });
  });

  it("lets the headset user mute earcons without removing visual or haptic feedback", async () => {
    const relay = new FakeVoiceRelay();
    const capture = {
      finish: vi.fn(async () => ({ text: "Build a quiet blue arch", sequence: 1 })),
      cancel: vi.fn(async () => undefined),
    };
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => capture) };
    const cues: XrViewerVoiceCuePort = { play: vi.fn(), stop: vi.fn() };
    const { transport, renderer } = viewer({ speech, voiceRelay: relay, voiceCues: cues });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await waitFor(() => expect(relay.inspect).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("checkbox", { name: /Play short voice feedback sounds/i }));
    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));

    await waitFor(() => expect(relay.stage).toHaveBeenCalledOnce());
    expect(cues.play).not.toHaveBeenCalled();
    expect(renderer.pulseXRVoiceHaptics).toHaveBeenCalledWith("listen_start");
    expect(renderer.pulseXRVoiceHaptics).toHaveBeenCalledWith("listen_stop");
    expect(renderer.pulseXRVoiceHaptics).toHaveBeenCalledWith("draft_ready");
    expect(screen.getByText("Build a quiet blue arch")).toBeVisible();
  });

  it("stages a Relay transcript on release and sends it only after explicit confirmation", async () => {
    const relay = new FakeVoiceRelay();
    let partial: ((value: Readonly<{ text: string; sequence: number }>) => void) | undefined;
    const capture = {
      finish: vi.fn(async () => ({ text: "Build a safe blue arch", sequence: 2 })),
      cancel: vi.fn(async () => undefined),
    };
    const speech: XrViewerSpeechPort = {
      begin: vi.fn(async (request) => {
        partial = request.onPartial;
        return capture;
      }),
    };
    const cues: XrViewerVoiceCuePort = { play: vi.fn() };
    const { transport } = viewer({ speech, voiceRelay: relay, voiceCues: cues });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await waitFor(() => expect(relay.inspect).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await waitFor(() => expect(speech.begin).toHaveBeenCalledOnce());
    act(() => partial?.({ text: "Build a safe", sequence: 1 }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));

    await waitFor(() => expect(relay.stage).toHaveBeenCalledWith({
      utteranceId: "viewer-request-0001",
      text: "Build a safe blue arch",
    }));
    expect(transport.sent).toEqual([]);
    expect(relay.confirm).not.toHaveBeenCalled();
    expect(screen.getByText("Build a safe blue arch")).toBeVisible();
    expect(screen.getByText(/Target: Codex · SemaFrame/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Confirm send once/i }));
    await waitFor(() => expect(relay.confirm).toHaveBeenCalledWith("relay-stage-1"));
    expect(transport.sent).toEqual([]);
    expect(await screen.findByText("The Agent completed the requested scene.")).toBeVisible();
    expect(cues.play).toHaveBeenCalledWith("draft_ready");
    expect(cues.play).toHaveBeenCalledWith("sent");
    expect(cues.play).toHaveBeenCalledWith("reply_ready");
  });

  it("cancels the exact staged Relay draft and can re-record without sending it", async () => {
    const relay = new FakeVoiceRelay();
    const captures = [
      { finish: vi.fn(async () => ({ text: "First draft", sequence: 1 })), cancel: vi.fn() },
      { finish: vi.fn(async () => ({ text: "Replacement draft", sequence: 1 })), cancel: vi.fn() },
    ];
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => captures.shift()!) };
    const { transport } = viewer({ speech, voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await waitFor(() => expect(relay.inspect).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));
    await screen.findByRole("button", { name: /Re-record/i });
    await userEvent.click(screen.getByRole("button", { name: /Re-record/i }));

    await waitFor(() => expect(relay.cancel).toHaveBeenCalledWith("relay-stage-1"));
    await waitFor(() => expect(speech.begin).toHaveBeenCalledTimes(2));
    expect(relay.confirm).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it("cleans the exact Relay draft, capture output, and cues before closing an expired session", async () => {
    const relay = new FakeVoiceRelay();
    const capture = {
      finish: vi.fn(async () => ({ text: "Unsent expired-session draft", sequence: 1 })),
      cancel: vi.fn(async () => undefined),
    };
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => capture) };
    const output: XrViewerSpeechOutputPort = { speak: vi.fn(async () => undefined), stop: vi.fn() };
    const cues: XrViewerVoiceCuePort = { play: vi.fn(), stop: vi.fn() };
    const { transport } = viewer({ speech, voiceRelay: relay, speechOutput: output, voiceCues: cues });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));
    await screen.findByRole("button", { name: /Confirm send once/i });

    act(() => transport.request?.onDisconnected({
      reason: "authority epoch expired",
      retryable: false,
    }));

    await waitFor(() => expect(relay.cancel).toHaveBeenCalledWith("relay-stage-1"));
    expect(output.stop).toHaveBeenCalledWith("session_expired");
    expect(cues.stop).toHaveBeenCalledOnce();
    await waitFor(() => expect(transport.session.close).toHaveBeenCalledWith("fresh_pairing_required"));
    expect(relay.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      (transport.session.close as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByRole("heading", { name: /Connect this renderer/i })).toBeVisible();
  });

  it("starts a new PTT turn after a sent reply without trying to cancel the already-sent stage", async () => {
    const relay = new FakeVoiceRelay();
    const captures = [
      { finish: vi.fn(async () => ({ text: "First instruction", sequence: 1 })), cancel: vi.fn() },
      { finish: vi.fn(async () => ({ text: "Second instruction", sequence: 1 })), cancel: vi.fn() },
    ];
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => captures.shift()!) };
    const { transport } = viewer({ speech, voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await waitFor(() => expect(relay.inspect).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Confirm send once/i }));
    expect(await screen.findByText("The Agent completed the requested scene.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Start push to talk/i }));
    await waitFor(() => expect(speech.begin).toHaveBeenCalledTimes(2));
    expect(relay.cancel).not.toHaveBeenCalled();
  });

  it("reads a completed Relay reply once and lets PTT barge in to stop speech", async () => {
    const relay = new FakeVoiceRelay();
    const capture = {
      finish: vi.fn(async () => ({ text: "Create a room", sequence: 1 })),
      cancel: vi.fn(),
    };
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => capture) };
    const speaking = deferred<void>();
    const output: XrViewerSpeechOutputPort = {
      speak: vi.fn(() => speaking.promise),
      stop: vi.fn(),
    };
    const { transport } = viewer({
      speech,
      voiceRelay: relay,
      speechOutput: output,
      readRepliesAloud: true,
    });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot();
    await userEvent.click(await screen.findByRole("button", { name: /Start push to talk/i }));
    await userEvent.click(screen.getByRole("button", { name: /Finish and stage draft/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Confirm send once/i }));
    await waitFor(() => expect(output.speak).toHaveBeenCalledWith(expect.objectContaining({
      text: "The Agent completed the requested scene.",
    })));

    await userEvent.click(screen.getByRole("button", { name: /Stop reading/i }));
    expect(output.stop).toHaveBeenCalledWith("user_cancelled");
    speaking.resolve();
  });

  it("binds immersive controller PTT press/release and publishes world feedback", async () => {
    const rawSession = {} as XRSession;
    const runtime: XrViewerWebXRRuntimePort = {
      probe: vi.fn(async () => ({
        runtimeId: "test-webxr",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller", "hand"] as const,
      })),
      requestSession: vi.fn(async () => ({
        id: "webxr-session-ptt",
        mode: "immersive-vr" as const,
        referenceSpace: "local-floor" as const,
        rawSession,
        end: vi.fn(async () => undefined),
        onEnded: () => () => undefined,
      })),
    };
    const capture = {
      finish: vi.fn(async () => ({ text: "Build a blue wall", sequence: 1 })),
      cancel: vi.fn(async () => undefined),
    };
    const speech: XrViewerSpeechPort = { begin: vi.fn(async () => capture) };
    const relay = new FakeVoiceRelay();
    const { transport, renderer } = viewer({ runtime, speech, voiceRelay: relay });
    await waitFor(() => expect(transport.pair).toHaveBeenCalledOnce());
    await transport.publishSnapshot(7);
    await userEvent.click(await screen.findByRole("button", { name: "Enter XR" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit XR" })).toBeVisible());

    act(() => renderer.callbacks?.onPushToTalk({
      phase: "pressed",
      input: "controller",
      handedness: "right",
    }));
    act(() => renderer.callbacks?.onPushToTalk({
      phase: "released",
      input: "controller",
      handedness: "right",
    }));

    await waitFor(() => expect(relay.stage).toHaveBeenCalledWith(expect.objectContaining({
      text: "Build a blue wall",
    })));
    expect(renderer.setXRVoiceFeedback).toHaveBeenCalledWith({
      phase: "listening",
      targetLabel: "Codex · SemaFrame",
    });
    await waitFor(() => expect(renderer.setXRVoiceFeedback).toHaveBeenCalledWith({
      phase: "awaiting_confirmation",
      subtitle: "Build a blue wall",
      targetLabel: "Codex · SemaFrame",
      actions: ["confirm", "cancel"],
    }));
    expect(transport.sent.filter(({ inputType }) => inputType === "voice_final")).toEqual([]);
  });
});
