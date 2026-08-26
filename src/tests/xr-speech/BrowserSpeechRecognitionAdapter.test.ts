import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSpeechRecognitionAdapter,
  probeBrowserSpeechRecognition,
  type BrowserSpeechRecognitionErrorEventLike,
  type BrowserSpeechRecognitionLike,
  type BrowserSpeechRecognitionResultEventLike,
  type BrowserSpeechRecognitionResultLike,
  type BrowserSpeechRecognitionResultListLike,
  type XrSpeechPort,
} from "../../xr/speech";

class FakeSpeechRecognition implements BrowserSpeechRecognitionLike {
  static readonly instances: FakeSpeechRecognition[] = [];
  static startError: unknown;
  static startHook: ((instance: FakeSpeechRecognition) => void) | undefined;
  static stopHook: ((instance: FakeSpeechRecognition) => void) | undefined;

  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onresult: ((event: BrowserSpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: BrowserSpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  readonly start = vi.fn(() => {
    FakeSpeechRecognition.startHook?.(this);
    if (FakeSpeechRecognition.startError !== undefined) throw FakeSpeechRecognition.startError;
  });
  readonly stop = vi.fn(() => FakeSpeechRecognition.stopHook?.(this));
  readonly abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  emitResults(...segments: ReadonlyArray<Readonly<{ text: string; final?: boolean }>>): void {
    const results = segments.map(({ text, final = false }) => {
      const alternative = Object.freeze({ transcript: text, confidence: 0.8 });
      return {
        0: alternative,
        isFinal: final,
        length: 1,
        item: (index: number) => index === 0 ? alternative : null,
      } satisfies BrowserSpeechRecognitionResultLike;
    });
    const list = Object.assign(results, {
      item: (index: number) => results[index] ?? null,
    }) as BrowserSpeechRecognitionResultListLike;
    this.onresult?.({ resultIndex: 0, results: list });
  }

  emitError(error: string): void {
    this.onerror?.({ error, message: "provider detail must not escape" });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

class FakeWebkitSpeechRecognition extends FakeSpeechRecognition {}

function createAdapter(
  options: Partial<ConstructorParameters<typeof BrowserSpeechRecognitionAdapter>[0]> = {},
): BrowserSpeechRecognitionAdapter {
  return new BrowserSpeechRecognitionAdapter({
    constructors: { SpeechRecognition: FakeSpeechRecognition },
    userActivation: { isActive: true },
    maxDurationMs: 2_000,
    finishGraceMs: 100,
    ...options,
  });
}

function begin(
  adapter: BrowserSpeechRecognitionAdapter,
  input: Readonly<{
    abort?: AbortController;
    partials?: Array<{ text: string; sequence: number }>;
    onPartial?: (partial: { text: string; sequence: number }) => void;
  }> = {},
) {
  const abort = input.abort ?? new AbortController();
  const partials = input.partials ?? [];
  return adapter.begin({
    utteranceId: "utterance-test",
    signal: abort.signal,
    onPartial: input.onPartial ?? ((partial) => partials.push(partial)),
  });
}

describe("BrowserSpeechRecognitionAdapter", () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances.length = 0;
    FakeSpeechRecognition.startError = undefined;
    FakeSpeechRecognition.startHook = undefined;
    FakeSpeechRecognition.stopHook = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("probes standard, prefixed, and unavailable runtimes without starting or instantiating capture", () => {
    expect(probeBrowserSpeechRecognition({
      SpeechRecognition: FakeSpeechRecognition,
      webkitSpeechRecognition: FakeWebkitSpeechRecognition,
    })).toMatchObject({
      available: true,
      provider: "speech-recognition",
      interimResults: true,
      audioPersistence: "forbidden",
      transcriptPersistence: "forbidden",
    });
    expect(probeBrowserSpeechRecognition({
      webkitSpeechRecognition: FakeWebkitSpeechRecognition,
    })).toMatchObject({ available: true, provider: "webkit-speech-recognition" });
    expect(probeBrowserSpeechRecognition({})).toMatchObject({
      available: false,
      provider: null,
      reason: "SpeechRecognition is unavailable in this browser.",
    });
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it("can start through an injected webkitSpeechRecognition constructor", async () => {
    const adapter = createAdapter({
      constructors: { webkitSpeechRecognition: FakeWebkitSpeechRecognition },
    });
    expect(adapter.probe()).toMatchObject({
      available: true,
      provider: "webkit-speech-recognition",
    });
    const capture = await begin(adapter);
    expect(FakeSpeechRecognition.instances[0]).toBeInstanceOf(FakeWebkitSpeechRecognition);
    capture.cancel("test_complete");
  });

  it("is structurally compatible with the viewer speech port and starts only from begin()", async () => {
    const adapter = createAdapter({ language: "zh-cn" });
    const speechPort: XrSpeechPort = adapter;
    expect(adapter.probe().available).toBe(true);
    expect(FakeSpeechRecognition.instances).toHaveLength(0);

    const capture = await begin(speechPort as BrowserSpeechRecognitionAdapter);
    const runtime = FakeSpeechRecognition.instances[0];
    expect(capture).toBeDefined();
    expect(runtime).toMatchObject({
      continuous: true,
      interimResults: true,
      lang: "zh-CN",
      maxAlternatives: 1,
    });
    expect(runtime?.start).toHaveBeenCalledOnce();
    capture.cancel("test_complete");
  });

  it("emits monotonic changed partials and resolves one normalized bounded final transcript", async () => {
    const partials: Array<{ text: string; sequence: number }> = [];
    const capture = await begin(createAdapter(), { partials });
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "  move   the", final: false });
    runtime.emitResults(
      { text: "move the", final: true },
      { text: " blue box ", final: false },
    );
    runtime.emitResults(
      { text: "move the", final: true },
      { text: " blue box ", final: false },
    );

    const firstFinish = capture.finish();
    const secondFinish = capture.finish();
    expect(secondFinish).toBe(firstFinish);
    expect(runtime.stop).toHaveBeenCalledOnce();
    runtime.emitResults(
      { text: "move the", final: true },
      { text: "blue box", final: true },
    );
    runtime.emitEnd();

    await expect(firstFinish).resolves.toEqual({ text: "move the blue box", sequence: 3 });
    await expect(secondFinish).resolves.toEqual({ text: "move the blue box", sequence: 3 });
    expect(partials).toEqual([
      { text: "move the", sequence: 1 },
      { text: "move the blue box", sequence: 2 },
    ]);
  });

  it("uses the latest non-empty interim transcript when the provider ends without marking it final", async () => {
    const partials: Array<{ text: string; sequence: number }> = [];
    const capture = await begin(createAdapter(), { partials });
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "create a lamp", final: false });
    runtime.emitEnd();

    await expect(capture.finish()).resolves.toEqual({ text: "create a lamp", sequence: 2 });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("preserves an interim suffix after a final prefix when end arrives without a promotion event", async () => {
    const capture = await begin(createAdapter());
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults(
      { text: "place the chair", final: true },
      { text: "by the window", final: false },
    );
    runtime.emitEnd();

    await expect(capture.finish()).resolves.toMatchObject({ text: "place the chair by the window" });
  });

  it("settles from the latest transcript after the bounded finish grace when a provider omits end", async () => {
    vi.useFakeTimers();
    const capture = await begin(createAdapter({ finishGraceMs: 50, maxDurationMs: 1_000 }));
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "turn the light on" });
    const final = capture.finish();
    await vi.advanceTimersByTimeAsync(50);

    await expect(final).resolves.toEqual({ text: "turn the light on", sequence: 2 });
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("rejects empty capture and maps provider errors without exposing provider detail", async () => {
    const emptyCapture = await begin(createAdapter());
    const emptyRuntime = FakeSpeechRecognition.instances[0]!;
    const emptyFinal = emptyCapture.finish();
    emptyRuntime.emitEnd();
    await expect(emptyFinal).rejects.toMatchObject({ code: "no_transcript" });

    const deniedCapture = await begin(createAdapter());
    const deniedRuntime = FakeSpeechRecognition.instances[1]!;
    const deniedFinal = deniedCapture.finish();
    deniedRuntime.emitError("not-allowed");
    await expect(deniedFinal).rejects.toMatchObject({
      code: "permission_denied",
      message: "Microphone or speech-recognition permission was denied.",
    });
    await expect(deniedFinal).rejects.not.toThrow("provider detail must not escape");
  });

  it("lets cancellation, AbortSignal, timeout, and late end/result races settle only once", async () => {
    vi.useFakeTimers();
    const capture = await begin(createAdapter({ maxDurationMs: 250 }));
    const runtime = FakeSpeechRecognition.instances[0]!;
    const final = capture.finish();
    capture.cancel("sensitive caller reason");
    runtime.emitResults({ text: "must not win", final: true });
    runtime.emitEnd();
    await expect(final).rejects.toMatchObject({
      code: "cancelled",
      message: "Speech capture was cancelled.",
    });
    expect(runtime.abort).toHaveBeenCalledOnce();

    const abort = new AbortController();
    const abortedCapture = await begin(createAdapter({ maxDurationMs: 250 }), { abort });
    const abortedRuntime = FakeSpeechRecognition.instances[1]!;
    abort.abort("private reason");
    await expect(abortedCapture.finish()).rejects.toMatchObject({ code: "aborted" });
    abortedRuntime.emitError("network");
    abortedRuntime.emitEnd();
    await expect(abortedCapture.finish()).rejects.toMatchObject({ code: "aborted" });

    const timedCapture = await begin(createAdapter({ maxDurationMs: 250 }));
    const timedRuntime = FakeSpeechRecognition.instances[2]!;
    await vi.advanceTimersByTimeAsync(250);
    await expect(timedCapture.finish()).rejects.toMatchObject({ code: "timeout" });
    expect(timedRuntime.abort).toHaveBeenCalledOnce();
  });

  it("rejects begin when AbortSignal wins synchronously inside provider startup", async () => {
    const abort = new AbortController();
    FakeSpeechRecognition.startHook = () => abort.abort("startup_cancelled");

    await expect(begin(createAdapter(), { abort })).rejects.toMatchObject({ code: "aborted" });
    expect(FakeSpeechRecognition.instances[0]?.abort).toHaveBeenCalledOnce();
  });

  it("fails closed when a transcript exceeds the configured bound", async () => {
    const capture = await begin(createAdapter({ maxTranscriptChars: 10 }));
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "this transcript is too long", final: true });

    await expect(capture.finish()).rejects.toMatchObject({ code: "transcript_too_long" });
    expect(runtime.abort).toHaveBeenCalledOnce();
  });

  it("fails closed when the partial consumer throws", async () => {
    const capture = await begin(createAdapter(), {
      onPartial: () => { throw new Error("consumer failed"); },
    });
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "hello" });

    await expect(capture.finish()).rejects.toMatchObject({ code: "partial_callback_failed" });
    expect(runtime.abort).toHaveBeenCalledOnce();
  });

  it("rejects unavailable providers, inactive user gestures, invalid requests, and start failures clearly", async () => {
    const unavailable = new BrowserSpeechRecognitionAdapter({
      constructors: {},
      userActivation: { isActive: true },
    });
    await expect(begin(unavailable)).rejects.toMatchObject({ code: "unavailable" });

    await expect(begin(createAdapter({ userActivation: { isActive: false } })))
      .rejects.toMatchObject({ code: "not_user_initiated" });

    const adapter = createAdapter();
    await expect(adapter.begin({
      utteranceId: "  ",
      signal: new AbortController().signal,
      onPartial: () => undefined,
    })).rejects.toMatchObject({ code: "invalid_request" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(begin(adapter, { abort: alreadyAborted })).rejects.toMatchObject({ code: "aborted" });

    FakeSpeechRecognition.startError = new Error("native start detail");
    await expect(begin(adapter)).rejects.toMatchObject({
      code: "provider_error",
      message: "The browser speech provider could not start.",
    });
  });

  it("validates BCP-47 language and all safety bounds before touching the provider", () => {
    expect(() => createAdapter({ language: "not_a_language" })).toThrowError(expect.objectContaining({
      code: "invalid_language",
    }));
    expect(() => createAdapter({ maxDurationMs: 249 })).toThrowError(expect.objectContaining({
      code: "invalid_configuration",
    }));
    expect(() => createAdapter({ maxDurationMs: 120_001 })).toThrowError(expect.objectContaining({
      code: "invalid_configuration",
    }));
    expect(() => createAdapter({ maxTranscriptChars: 4_001 })).toThrowError(expect.objectContaining({
      code: "invalid_configuration",
    }));
    expect(() => createAdapter({ finishGraceMs: 5_001 })).toThrowError(expect.objectContaining({
      code: "invalid_configuration",
    }));
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it("does not write audio or transcripts to browser storage and does not log them", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const capture = await begin(createAdapter());
    const runtime = FakeSpeechRecognition.instances[0]!;
    runtime.emitResults({ text: "private command", final: true });
    runtime.emitEnd();
    await capture.finish();

    expect(storageWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
