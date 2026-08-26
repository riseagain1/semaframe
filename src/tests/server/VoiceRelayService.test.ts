import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryVoiceRelayNativePort,
  VoiceRelayService,
} from "../../../server/voice-relay";

async function readyService(options: Readonly<{ now?: () => number }> = {}) {
  const native = new InMemoryVoiceRelayNativePort();
  let id = 0;
  const service = new VoiceRelayService(native, {
    now: options.now,
    requestDigestKey: new Uint8Array(32).fill(7),
    stageIdFactory: () => `relay-stage-${String(++id).padStart(4, "0")}`,
  });
  const prepared = await service.prepareSetup();
  const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
  await service.arm(target.targetId);
  return { native, service, target };
}

describe("VoiceRelayService", () => {
  afterEach(() => vi.useRealTimers());
  it("stages an exact draft without sending and confirms it exactly once", async () => {
    const { native, service, target } = await readyService();
    const staged = await service.stage({
      utteranceId: "utterance-0001",
      text: "Build a blue table",
    });

    expect(staged).toMatchObject({
      stageId: "relay-stage-0001",
      target,
      status: "awaiting_confirmation",
    });
    expect(native.draft).toBe("Build a blue table");
    expect(native.sendCount).toBe(0);
    expect(service.inspect()).toMatchObject({ phase: "awaiting_confirmation", armed: true });

    const confirmed = await service.confirm(staged.stageId);
    expect(confirmed).toEqual({
      stageId: staged.stageId,
      status: "sent",
      observationAvailable: true,
    });
    expect(native.sendCount).toBe(1);
    expect(native.draft).toBe("");

    expect(await service.confirm(staged.stageId)).toEqual(confirmed);
    expect(native.sendCount).toBe(1);
  });

  it("binds confirmation to the exact native target generation returned at staging", async () => {
    const { native, service, target } = await readyService();
    const text = "Build a generation-bound desk";
    const staged = await service.stage({ utteranceId: "utterance-generation", text });
    const draftDigest = createHash("sha256").update(text, "utf8").digest("hex");

    await expect(native.confirmDraft({
      targetId: target.targetId,
      stageId: staged.stageId,
      expectedDraftDigest: draftDigest,
      targetGeneration: "stale-generation",
    })).resolves.toEqual({ outcome: "blocked", reason: "draft_changed" });
    expect(native.sendCount).toBe(0);
    expect(native.draft).toBe(text);

    await expect(service.confirm(staged.stageId)).resolves.toMatchObject({ status: "sent" });
    expect(native.sendCount).toBe(1);
  });

  it("disarms and erases the native draft when staging omits its generation binding", async () => {
    const { native, service } = await readyService();
    const stageDraft = native.stageDraft.bind(native);
    vi.spyOn(native, "stageDraft").mockImplementationOnce(async (input) => {
      const result = await stageDraft(input);
      if (result.outcome !== "staged") return result;
      const { targetGeneration: _omitted, ...withoutGeneration } = result;
      return withoutGeneration;
    });

    await expect(service.stage({
      utteranceId: "utterance-missing-generation",
      text: "Never leave this malformed stage behind",
    })).rejects.toMatchObject({ code: "target_generation_invalid", status: 502 });
    expect(native.draft).toBe("");
    expect(service.inspect()).toMatchObject({ armed: false, phase: "ready" });
  });

  it("compensates an exact native draft when the stage acknowledgement is lost", async () => {
    const { native, service } = await readyService();
    const stageDraft = native.stageDraft.bind(native);
    vi.spyOn(native, "stageDraft").mockImplementationOnce(async (input) => {
      await stageDraft(input);
      throw new Error("Simulated lost stage acknowledgement");
    });

    await expect(service.stage({
      utteranceId: "utterance-lost-stage-ack",
      text: "This draft must be compensated exactly",
    })).rejects.toMatchObject({ code: "draft_staging_interrupted", status: 409 });
    expect(native.abortCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect()).toMatchObject({ armed: true, phase: "ready" });
  });

  it("compensates an exact native draft after AbortSignal interrupts staging", async () => {
    const { native, service } = await readyService();
    const stageDraft = native.stageDraft.bind(native);
    vi.spyOn(native, "stageDraft").mockImplementationOnce(async (input, signal) => {
      await stageDraft(input);
      return await new Promise<Awaited<ReturnType<typeof stageDraft>>>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const controller = new AbortController();
    const staging = service.stage({
      utteranceId: "utterance-aborted-stage",
      text: "Remove this draft even if the caller goes away",
    }, controller.signal);
    const rejection = expect(staging).rejects.toMatchObject({ code: "draft_staging_interrupted", status: 409 });
    await vi.waitFor(() => expect(native.draft).toBe("Remove this draft even if the caller goes away"));
    controller.abort();

    await rejection;
    expect(native.abortCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect()).toMatchObject({ armed: true, phase: "ready" });
  });

  it("never erases a human edit while compensating a lost stage acknowledgement", async () => {
    const { native, service } = await readyService();
    const stageDraft = native.stageDraft.bind(native);
    vi.spyOn(native, "stageDraft").mockImplementationOnce(async (input) => {
      await stageDraft(input);
      native.editDraft("Human-authored replacement after native staging");
      throw new Error("Simulated lost stage acknowledgement");
    });

    await expect(service.stage({
      utteranceId: "utterance-lost-stage-human-edit",
      text: "Original relay draft",
    })).rejects.toMatchObject({ code: "draft_changed", status: 409, recoverable: false });
    expect(native.abortCount).toBe(1);
    expect(native.draft).toBe("Human-authored replacement after native staging");
    expect(service.inspect()).toMatchObject({ armed: false, phase: "ready" });
  });

  it("closes the helper when an ambiguous stage cannot be exactly aborted", async () => {
    const { native, service } = await readyService();
    const stageDraft = native.stageDraft.bind(native);
    vi.spyOn(native, "stageDraft").mockImplementationOnce(async (input) => {
      await stageDraft(input);
      throw new Error("Simulated lost stage acknowledgement");
    });
    vi.spyOn(native, "abortStage").mockRejectedValueOnce(new Error("Simulated lost abort acknowledgement"));

    await expect(service.stage({
      utteranceId: "utterance-unresolved-stage",
      text: "Close the helper if exact compensation is unprovable",
    })).rejects.toMatchObject({ code: "draft_staging_outcome_unknown", status: 503, recoverable: false });
    expect(native.closed).toBe(true);
    expect(native.draft).toBe("");
    expect(service.inspect()).toEqual({ enabled: false, armed: false, phase: "off" });
  });

  it("disables the relay when native disarm cannot prove owned-draft cleanup", async () => {
    const { native, service } = await readyService();
    vi.spyOn(native, "disarm").mockRejectedValueOnce(new Error("cleanup remains unresolved"));

    await expect(service.disarm()).rejects.toMatchObject({
      code: "draft_cleanup_unresolved",
      status: 503,
      recoverable: false,
    });
    expect(native.closed).toBe(true);
    expect(service.inspect()).toEqual({ enabled: false, armed: false, phase: "off" });
  });

  it("cancels only the removed owner's unsent stage", async () => {
    const { native, service } = await readyService();
    const owner = { ownerId: "xr-session-cancelled" } as const;
    await service.stage({
      utteranceId: "utterance-owned-cancel",
      text: "Draft owned by the removed XR session",
    }, undefined, owner);

    await expect(service.cancelOwner("xr-session-other")).resolves.toBe(0);
    expect(native.draft).toBe("Draft owned by the removed XR session");
    await expect(service.cancelOwner(owner.ownerId)).resolves.toBe(1);
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect(owner)).toMatchObject({ phase: "ready" });
  });

  it("preserves a human edit and disarms when owner cleanup cannot cancel the exact draft", async () => {
    const { native, service } = await readyService();
    const owner = { ownerId: "xr-session-human-edit" } as const;
    await service.stage({
      utteranceId: "utterance-owned-human-edit",
      text: "Original XR-owned draft",
    }, undefined, owner);
    native.editDraft("Human-authored replacement");

    await expect(service.cancelOwner(owner.ownerId)).resolves.toBe(1);
    expect(native.draft).toBe("Human-authored replacement");
    expect(native.closed).toBe(false);
    expect(service.inspect()).toMatchObject({ armed: false, phase: "ready" });
    expect(service.inspect(owner)).not.toHaveProperty("activeStage");
  });

  it("closes the native relay when owner cancellation acknowledgement is ambiguous", async () => {
    const { native, service } = await readyService();
    const owner = { ownerId: "xr-session-cancel-ambiguous" } as const;
    await service.stage({
      utteranceId: "utterance-owned-cancel-ambiguous",
      text: "Draft with a lost cancellation acknowledgement",
    }, undefined, owner);
    vi.spyOn(native, "cancelDraft").mockRejectedValueOnce(new Error("lost cancel acknowledgement"));

    await expect(service.cancelOwner(owner.ownerId)).resolves.toBe(1);
    expect(native.closed).toBe(true);
    expect(native.draft).toBe("");
    expect(service.inspect()).toEqual({ enabled: false, armed: false, phase: "off" });
    await expect(service.stage({ utteranceId: "utterance-after-owner-close", text: "Must not stage" }))
      .rejects.toMatchObject({ code: "relay_closed", recoverable: false });
  });

  it("allows the next draft immediately when a successful Send has no reply observation", async () => {
    const native = new InMemoryVoiceRelayNativePort({
      target: Object.freeze({
        targetId: "mock-agent-without-replies",
        label: "Mock Agent without reply observation",
        capabilities: Object.freeze({
          draftInsertion: true,
          explicitSend: true,
          replyObservation: false,
        }),
      }),
    });
    let id = 0;
    const service = new VoiceRelayService(native, {
      requestDigestKey: new Uint8Array(32).fill(8),
      stageIdFactory: () => `relay-stage-no-reply-${++id}`,
    });
    const prepared = await service.prepareSetup();
    const target = await service.configureTarget({ candidateId: prepared.candidates[0]!.candidateId });
    await service.arm(target.targetId);

    const first = await service.stage({ utteranceId: "utterance-no-reply-1", text: "Create a blue cube" });
    await expect(service.confirm(first.stageId)).resolves.toEqual({
      stageId: first.stageId,
      status: "sent",
      observationAvailable: false,
    });
    expect(service.inspect().phase).toBe("ready");
    await expect(service.stage({ utteranceId: "utterance-no-reply-2", text: "Create a red sphere" }))
      .resolves.toMatchObject({ status: "awaiting_confirmation" });
    expect(native.sendCount).toBe(1);
    expect(native.stageCount).toBe(2);
  });

  it("deduplicates response-loss staging retries and rejects changed text", async () => {
    const { native, service } = await readyService();
    const request = { utteranceId: "utterance-retry", text: "Create a lamp" } as const;
    const first = await service.stage(request);
    expect(await service.stage(structuredClone(request))).toEqual(first);
    expect(native.stageCount).toBe(1);

    await expect(service.stage({ ...request, text: "Delete the lamp" }))
      .rejects.toMatchObject({ code: "utterance_idempotency_conflict", status: 409 });
    expect(native.draft).toBe("Create a lamp");
    expect(native.sendCount).toBe(0);
  });

  it("binds stages to one authenticated owner without exposing them to another", async () => {
    const { service } = await readyService();
    const firstOwner = { ownerId: "xr-session-alpha" } as const;
    const otherOwner = { ownerId: "xr-session-bravo" } as const;
    const staged = await service.stage(
      { utteranceId: "shared-utterance-id", text: "Create a private draft" },
      undefined,
      firstOwner,
    );

    expect(service.inspect(firstOwner)).toMatchObject({
      phase: "awaiting_confirmation",
      activeStage: { stageId: staged.stageId },
    });
    expect(service.inspect(otherOwner)).toMatchObject({ phase: "ready" });
    expect(service.inspect(otherOwner)).not.toHaveProperty("activeStage");
    // The trusted local desktop remains an administrative surface.
    expect(service.inspect()).toHaveProperty("activeStage.stageId", staged.stageId);

    const missingStage = service.confirm("relay-stage-does-not-exist", undefined, otherOwner);
    const foreignStage = service.confirm(staged.stageId, undefined, otherOwner);
    await expect(missingStage).rejects.toMatchObject({
      code: "stage_not_found",
      status: 404,
      message: "Voice Relay stage is unavailable or expired.",
    });
    await expect(foreignStage).rejects.toMatchObject({
      code: "stage_not_found",
      status: 404,
      message: "Voice Relay stage is unavailable or expired.",
    });
    await expect(service.cancel(staged.stageId, undefined, otherOwner))
      .rejects.toMatchObject({ code: "stage_not_found", status: 404 });
    await expect(service.readReply(staged.stageId, 0, undefined, otherOwner))
      .rejects.toMatchObject({ code: "stage_not_found", status: 404 });

    await expect(service.confirm(staged.stageId, undefined, firstOwner))
      .resolves.toMatchObject({ status: "sent" });
    await expect(service.readReply(staged.stageId, 0, undefined, firstOwner))
      .resolves.toMatchObject({ phase: "waiting" });
  });

  it("blocks confirmation and cancellation after the user edits the composer", async () => {
    const { native, service } = await readyService();
    const staged = await service.stage({ utteranceId: "utterance-edit", text: "Move the chair" });
    native.editDraft("Human-authored replacement");

    await expect(service.confirm(staged.stageId)).rejects.toMatchObject({ code: "draft_changed" });
    expect(native.sendCount).toBe(0);
    expect(native.draft).toBe("Human-authored replacement");
    expect(await service.cancel(staged.stageId)).toEqual({
      stageId: staged.stageId,
      status: "draft_changed",
    });
    expect(native.draft).toBe("Human-authored replacement");
  });

  it("clears only its unchanged draft when the user cancels", async () => {
    const { native, service } = await readyService();
    const staged = await service.stage({ utteranceId: "utterance-cancel", text: "Do not send this" });
    expect(await service.cancel(staged.stageId)).toEqual({
      stageId: staged.stageId,
      status: "cancelled",
    });
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");
    expect(await service.cancel(staged.stageId)).toEqual({
      stageId: staged.stageId,
      status: "already_cancelled",
    });
  });

  it("fails closed on acknowledgement loss and never retries an ambiguous Send", async () => {
    const { native, service } = await readyService();
    const staged = await service.stage({ utteranceId: "utterance-ambiguous", text: "Send exactly once" });
    native.failNextConfirmAfterSend();

    expect(await service.confirm(staged.stageId)).toEqual({
      stageId: staged.stageId,
      status: "send_outcome_unknown",
      observationAvailable: false,
    });
    expect(native.sendCount).toBe(1);
    expect(await service.confirm(staged.stageId)).toMatchObject({ status: "send_outcome_unknown" });
    expect(native.sendCount).toBe(1);
    await expect(service.cancel(staged.stageId)).rejects.toMatchObject({
      code: "send_outcome_unknown",
      recoverable: false,
    });
  });

  it("returns reply text transiently with monotonic sequence numbers", async () => {
    const { native, service } = await readyService();
    const staged = await service.stage({ utteranceId: "utterance-reply", text: "Describe the scene" });
    await service.confirm(staged.stageId);

    expect(await service.readReply(staged.stageId)).toEqual({
      stageId: staged.stageId,
      phase: "waiting",
      sequence: 0,
    });
    native.setReply("The room contains a table.", "streaming");
    expect(await service.readReply(staged.stageId)).toEqual({
      stageId: staged.stageId,
      phase: "streaming",
      sequence: 1,
      text: "The room contains a table.",
    });
    native.setReply("The room contains a table and two chairs.", "complete");
    expect(await service.readReply(staged.stageId)).toEqual({
      stageId: staged.stageId,
      phase: "complete",
      sequence: 2,
      text: "The room contains a table and two chairs.",
    });
    expect(service.inspect().phase).toBe("ready");
    await expect(service.stage({ utteranceId: "utterance-after-reply", text: "Create another object" }))
      .resolves.toMatchObject({ status: "awaiting_confirmation" });
  });

  it("retains an observed Send for the full 120-second reply polling window and then cleans it", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { service } = await readyService({ now: () => now });
    const staged = await service.stage({
      utteranceId: "utterance-retained-reply",
      text: "Reply after the draft deadline",
      ttlMs: 5_000,
    });
    await service.confirm(staged.stageId);

    now = 120_999;
    await vi.advanceTimersByTimeAsync(119_999);
    await expect(service.readReply(staged.stageId)).resolves.toMatchObject({
      stageId: staged.stageId,
      phase: "waiting",
    });

    now = 121_000;
    await vi.advanceTimersByTimeAsync(1);
    await expect(service.readReply(staged.stageId)).rejects.toMatchObject({
      code: "stage_not_found",
      status: 404,
    });
    expect(service.inspect().phase).toBe("ready");
  });

  it("automatically removes an expired unsent draft without waiting for another request", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { native, service } = await readyService({ now: () => now });
    await service.stage({
      utteranceId: "utterance-auto-expire",
      text: "Erase me at expiry",
      ttlMs: 5_000,
    });
    expect(native.draft).toBe("Erase me at expiry");

    now = 6_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");
    expect(service.inspect().phase).toBe("ready");
  });

  it("fails closed on ambiguous TTL cancellation instead of deleting an untracked native stage", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { native, service } = await readyService({ now: () => now });
    await service.stage({
      utteranceId: "utterance-expiry-ambiguous",
      text: "Expire through an ambiguous cancellation",
      ttlMs: 5_000,
    });
    vi.spyOn(native, "cancelDraft").mockRejectedValueOnce(new Error("lost expiry cancel acknowledgement"));

    now = 6_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.closed).toBe(true);
    expect(native.draft).toBe("");
    expect(service.inspect()).toEqual({ enabled: false, armed: false, phase: "off" });
  });

  it("preserves a human edit and disarms when an unsent stage expires", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { native, service } = await readyService({ now: () => now });
    await service.stage({
      utteranceId: "utterance-expiry-human-edit",
      text: "Original expiring draft",
      ttlMs: 5_000,
    });
    native.editDraft("Human replacement before expiry");

    now = 6_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.draft).toBe("Human replacement before expiry");
    expect(native.closed).toBe(false);
    expect(service.inspect()).toMatchObject({ armed: false, phase: "ready" });
  });

  it("retains a bounded idempotency tombstone after an expired utterance", async () => {
    let now = 1_000;
    const { service } = await readyService({ now: () => now });
    const request = {
      utteranceId: "utterance-expiry-tombstone",
      text: "Expire once and never replay immediately",
      ttlMs: 5_000,
    } as const;
    await service.stage(request);
    now = 6_000;
    await expect(service.stage(request)).rejects.toMatchObject({
      code: "utterance_already_terminal",
      recoverable: false,
    });
    await expect(service.stage({ ...request, text: "Conflicting replay" })).rejects.toMatchObject({
      code: "utterance_idempotency_conflict",
      recoverable: false,
    });
  });

  it("expires and erases an unsent draft before accepting another utterance", async () => {
    let now = 1_000;
    const { native, service } = await readyService({ now: () => now });
    const first = await service.stage({
      utteranceId: "utterance-expiring",
      text: "Temporary draft",
      ttlMs: 5_000,
    });
    now = first.expiresAtMs;
    await expect(service.confirm(first.stageId)).rejects.toMatchObject({ code: "stage_not_found" });
    expect(native.cancelCount).toBe(1);
    expect(native.draft).toBe("");

    await expect(service.stage({ utteranceId: "utterance-next", text: "Next draft" }))
      .resolves.toMatchObject({ status: "awaiting_confirmation" });
  });

  it("checks reply expiry synchronously even before the scheduled timer runs", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { service } = await readyService({ now: () => now });
    const staged = await service.stage({
      utteranceId: "utterance-sync-reply-expiry",
      text: "Do not read after the bounded reply window",
    });
    await service.confirm(staged.stageId);

    now = 121_000;
    await expect(service.readReply(staged.stageId)).rejects.toMatchObject({
      code: "stage_not_found",
      status: 404,
    });
    expect(service.inspect().phase).toBe("ready");
  });

  it("reports permission and target diagnostics without exposing locators", async () => {
    const deniedNative = new InMemoryVoiceRelayNativePort({ accessibility: "denied" });
    const denied = new VoiceRelayService(deniedNative);
    await expect(denied.prepareSetup()).resolves.toEqual({
      phase: "permission_required",
      platform: "mock",
      accessibility: "denied",
      candidates: [],
    });

    const { native, service } = await readyService();
    const report = await service.runDiagnostics({ performDraftRoundTrip: true });
    expect(report.ready).toBe(true);
    expect(native.probeCount).toBe(1);
    expect(native.draft).toBe("");
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["helper", "pass"],
      ["accessibility", "pass"],
      ["target", "pass"],
      ["draft_insertion", "pass"],
      ["explicit_send", "pass"],
      ["reply_observation", "pass"],
    ]);
    expect(JSON.stringify(service.inspect())).not.toMatch(/pid|locator|composer|windowTitle/iu);
  });

  it("keeps candidate identity stable and prompts only through the explicit accessibility API", async () => {
    const native = new InMemoryVoiceRelayNativePort();
    const service = new VoiceRelayService(native);

    await service.runDiagnostics();
    expect(native.prepareAccessibilityCount).toBe(0);

    const first = await service.prepareSetup();
    const second = await service.prepareSetup();
    expect(native.prepareAccessibilityCount).toBe(0);
    expect(second.candidates[0]!.candidateId).toBe(first.candidates[0]!.candidateId);

    const explicit = await service.requestAccessibility();
    expect(native.prepareAccessibilityCount).toBe(1);
    expect(explicit.candidates[0]!.candidateId).toBe(first.candidates[0]!.candidateId);

    // A human may click the candidate returned by the first preparation after
    // a refresh has completed. The selection must remain valid.
    await expect(service.configureTarget({ candidateId: first.candidates[0]!.candidateId }))
      .resolves.toMatchObject({ targetId: "mock-agent-main" });
  });

  it("cancels an unsent stage and erases all volatile data on close", async () => {
    const { native, service } = await readyService();
    await service.stage({ utteranceId: "utterance-close", text: "Secret transient draft" });
    await service.close();

    expect(native.closed).toBe(true);
    expect(native.draft).toBe("");
    expect(service.inspect()).toEqual({ enabled: false, armed: false, phase: "off" });
    await expect(service.stage({ utteranceId: "utterance-late", text: "No" }))
      .rejects.toMatchObject({ code: "relay_closed" });
  });
});
