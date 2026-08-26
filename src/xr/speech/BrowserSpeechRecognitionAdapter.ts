import type {
  XrSpeechBeginRequest,
  XrSpeechCapturePort,
  XrSpeechFinal,
  XrSpeechPort,
  XrSpeechProviderCapability,
} from "./contracts";

export interface BrowserSpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface BrowserSpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly 0?: BrowserSpeechRecognitionAlternativeLike;
  item?(index: number): BrowserSpeechRecognitionAlternativeLike | null;
}

export interface BrowserSpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionResultLike;
  item?(index: number): BrowserSpeechRecognitionResultLike | null;
}

export type BrowserSpeechRecognitionResultEventLike = Readonly<{
  resultIndex: number;
  results: BrowserSpeechRecognitionResultListLike;
}>;

export type BrowserSpeechRecognitionErrorEventLike = Readonly<{
  error: string;
  message?: string;
}>;

export interface BrowserSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognitionLike;

export type BrowserSpeechRecognitionConstructors = Readonly<{
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}>;

export type XrBrowserSpeechProvider = "speech-recognition" | "webkit-speech-recognition";

export type BrowserSpeechRecognitionCapability = XrSpeechProviderCapability & Readonly<{
  provider: XrBrowserSpeechProvider | null;
}>;

export type XrBrowserSpeechErrorCode =
  | "unavailable"
  | "not_user_initiated"
  | "invalid_request"
  | "invalid_language"
  | "invalid_configuration"
  | "aborted"
  | "cancelled"
  | "timeout"
  | "permission_denied"
  | "audio_capture_failed"
  | "network"
  | "language_not_supported"
  | "no_speech"
  | "no_transcript"
  | "transcript_too_long"
  | "provider_aborted"
  | "provider_error"
  | "partial_callback_failed";

export class XrBrowserSpeechError extends Error {
  constructor(
    readonly code: XrBrowserSpeechErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "XrBrowserSpeechError";
  }
}

export type BrowserSpeechRecognitionAdapterOptions = Readonly<{
  /** Canonicalized BCP-47 language passed to the browser recognizer. */
  language?: string;
  /** Hard wall-clock limit for one capture. Range: 250 ms to 120 seconds. */
  maxDurationMs?: number;
  /** Maximum returned transcript length. Range: 1 to 4,000 UTF-16 code units. */
  maxTranscriptChars?: number;
  /** Time allowed for final provider events after stop(). Range: 0 to 5 seconds. */
  finishGraceMs?: number;
  /** Explicit constructors make the adapter testable and avoid global mutation. */
  constructors?: BrowserSpeechRecognitionConstructors;
  /** Defaults to navigator.userActivation when available. */
  userActivation?: Readonly<{ isActive: boolean }> | null;
  /** Defaults to true. Missing userActivation APIs are allowed; an explicit false is rejected. */
  requireUserActivation?: boolean;
}>;

type ResolvedProvider = Readonly<{
  provider: XrBrowserSpeechProvider;
  Constructor: BrowserSpeechRecognitionConstructor;
}>;

type TerminalOutcome =
  | Readonly<{ kind: "success"; final: XrSpeechFinal }>
  | Readonly<{ kind: "error"; error: XrBrowserSpeechError }>;

type FinishDeferred = Readonly<{
  promise: Promise<XrSpeechFinal>;
  resolve(final: XrSpeechFinal): void;
  reject(error: XrBrowserSpeechError): void;
}>;

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_MAX_DURATION_MS = 30_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 4_000;
const DEFAULT_FINISH_GRACE_MS = 1_500;
const MIN_DURATION_MS = 250;
const MAX_DURATION_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 4_000;
const MAX_FINISH_GRACE_MS = 5_000;

function globalConstructors(): BrowserSpeechRecognitionConstructors {
  const root = globalThis as typeof globalThis & BrowserSpeechRecognitionConstructors;
  return {
    ...(typeof root.SpeechRecognition === "function"
      ? { SpeechRecognition: root.SpeechRecognition }
      : {}),
    ...(typeof root.webkitSpeechRecognition === "function"
      ? { webkitSpeechRecognition: root.webkitSpeechRecognition }
      : {}),
  };
}

function globalUserActivation(): Readonly<{ isActive: boolean }> | null {
  const navigation = globalThis.navigator as Navigator & {
    userActivation?: Readonly<{ isActive: boolean }>;
  };
  return navigation?.userActivation ?? null;
}

function resolveProvider(constructors: BrowserSpeechRecognitionConstructors): ResolvedProvider | undefined {
  if (typeof constructors.SpeechRecognition === "function") {
    return { provider: "speech-recognition", Constructor: constructors.SpeechRecognition };
  }
  if (typeof constructors.webkitSpeechRecognition === "function") {
    return { provider: "webkit-speech-recognition", Constructor: constructors.webkitSpeechRecognition };
  }
  return undefined;
}

function canonicalLanguage(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.length > 128) {
    throw new XrBrowserSpeechError("invalid_language", "Speech language must be a valid BCP-47 tag.");
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(candidate);
    if (!canonical) throw new RangeError("Missing canonical language");
    return canonical;
  } catch (cause) {
    throw new XrBrowserSpeechError(
      "invalid_language",
      "Speech language must be a valid BCP-47 tag.",
      { cause },
    );
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new XrBrowserSpeechError(
      "invalid_configuration",
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function validUtteranceId(value: string): void {
  const id = value.trim();
  if (!id || id.length > 256 || /[\p{Cc}]/u.test(id)) {
    throw new XrBrowserSpeechError("invalid_request", "Speech utterance id is invalid.");
  }
}

function normalizedTranscript(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function resultAt(
  results: BrowserSpeechRecognitionResultListLike,
  index: number,
): BrowserSpeechRecognitionResultLike | undefined {
  return results[index] ?? results.item?.(index) ?? undefined;
}

function alternativeAt(
  result: BrowserSpeechRecognitionResultLike,
  index: number,
): BrowserSpeechRecognitionAlternativeLike | undefined {
  return result[index as 0] ?? result.item?.(index) ?? undefined;
}

function providerError(event: BrowserSpeechRecognitionErrorEventLike): XrBrowserSpeechError {
  switch (event.error) {
    case "not-allowed":
    case "service-not-allowed":
      return new XrBrowserSpeechError(
        "permission_denied",
        "Microphone or speech-recognition permission was denied.",
      );
    case "audio-capture":
      return new XrBrowserSpeechError(
        "audio_capture_failed",
        "No usable microphone is available for speech capture.",
      );
    case "network":
      return new XrBrowserSpeechError("network", "The browser speech service could not be reached.");
    case "language-not-supported":
      return new XrBrowserSpeechError(
        "language_not_supported",
        "The configured speech language is not supported by this browser provider.",
      );
    case "no-speech":
      return new XrBrowserSpeechError("no_speech", "No speech was detected before capture ended.");
    case "aborted":
      return new XrBrowserSpeechError("provider_aborted", "The browser speech provider aborted capture.");
    default:
      return new XrBrowserSpeechError("provider_error", "The browser speech provider failed.");
  }
}

function deferredFinal(): FinishDeferred {
  let resolve!: (final: XrSpeechFinal) => void;
  let reject!: (error: XrBrowserSpeechError) => void;
  const promise = new Promise<XrSpeechFinal>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class BrowserSpeechRecognitionCapture implements XrSpeechCapturePort {
  private terminal?: TerminalOutcome;
  private finishDeferred?: FinishDeferred;
  private finishRequested = false;
  private providerEnded = false;
  private sequence = 0;
  private finalText = "";
  private previewText = "";
  private lastPartialText = "";
  private maximumTimer?: ReturnType<typeof globalThis.setTimeout>;
  private finishTimer?: ReturnType<typeof globalThis.setTimeout>;

  constructor(
    private readonly recognition: BrowserSpeechRecognitionLike,
    private readonly request: XrSpeechBeginRequest,
    private readonly maxDurationMs: number,
    private readonly maxTranscriptChars: number,
    private readonly finishGraceMs: number,
  ) {
    recognition.onresult = (event) => this.receiveResults(event);
    recognition.onerror = (event) => this.fail(providerError(event), true);
    recognition.onend = () => this.providerDidEnd();
    request.signal.addEventListener("abort", this.abortFromSignal, { once: true });
  }

  start(): void {
    if (this.request.signal.aborted) {
      this.fail(new XrBrowserSpeechError("aborted", "Speech capture was aborted before it began."), false);
      throw this.terminalError();
    }
    try {
      this.recognition.start();
    } catch (cause) {
      const error = new XrBrowserSpeechError(
        "provider_error",
        "The browser speech provider could not start.",
        { cause },
      );
      this.fail(error, true);
      throw error;
    }
    if (this.terminal?.kind === "error") throw this.terminal.error;
    if (this.terminal) return;
    this.maximumTimer = globalThis.setTimeout(() => {
      this.fail(
        new XrBrowserSpeechError("timeout", "Speech capture exceeded its maximum duration."),
        true,
      );
    }, this.maxDurationMs);
  }

  finish(): Promise<XrSpeechFinal> {
    if (!this.finishDeferred) this.finishDeferred = deferredFinal();
    if (this.terminal) {
      this.deliverTerminal();
      return this.finishDeferred.promise;
    }
    if (!this.finishRequested) {
      this.finishRequested = true;
      try {
        this.recognition.stop();
      } catch (cause) {
        this.fail(new XrBrowserSpeechError(
          "provider_error",
          "The browser speech provider could not finish capture.",
          { cause },
        ), true);
      }
      if (!this.terminal && !this.providerEnded) {
        this.finishTimer = globalThis.setTimeout(() => this.settleFromTranscript(), this.finishGraceMs);
      }
    }
    return this.finishDeferred.promise;
  }

  cancel(_reason = "cancelled"): void {
    this.fail(new XrBrowserSpeechError("cancelled", "Speech capture was cancelled."), true);
  }

  private readonly abortFromSignal = (): void => {
    this.fail(new XrBrowserSpeechError("aborted", "Speech capture was aborted."), true);
  };

  private receiveResults(event: BrowserSpeechRecognitionResultEventLike): void {
    if (this.terminal) return;
    const finalParts: string[] = [];
    const interimParts: string[] = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const result = resultAt(event.results, index);
      if (!result || result.length < 1) continue;
      const transcript = alternativeAt(result, 0)?.transcript;
      if (typeof transcript !== "string") continue;
      const normalized = normalizedTranscript(transcript);
      if (!normalized) continue;
      (result.isFinal ? finalParts : interimParts).push(normalized);
    }
    const finalText = normalizedTranscript(finalParts.join(" "));
    const previewText = normalizedTranscript([...finalParts, ...interimParts].join(" "));
    if (!previewText) return;
    if (previewText.length > this.maxTranscriptChars || finalText.length > this.maxTranscriptChars) {
      this.fail(new XrBrowserSpeechError(
        "transcript_too_long",
        `Speech transcript exceeds the ${this.maxTranscriptChars}-character limit.`,
      ), true);
      return;
    }
    this.finalText = finalText;
    this.previewText = previewText;
    if (previewText === this.lastPartialText) return;
    this.lastPartialText = previewText;
    const partial = Object.freeze({ text: previewText, sequence: ++this.sequence });
    try {
      this.request.onPartial(partial);
    } catch (cause) {
      this.fail(new XrBrowserSpeechError(
        "partial_callback_failed",
        "The speech partial consumer failed.",
        { cause },
      ), true);
    }
  }

  private providerDidEnd(): void {
    if (this.terminal) return;
    this.providerEnded = true;
    this.settleFromTranscript();
  }

  private settleFromTranscript(): void {
    if (this.terminal) return;
    // The preview is the full final prefix plus the latest interim suffix. A
    // few implementations emit `end` without promoting that suffix to final,
    // so prefer the complete bounded preview at the terminal boundary.
    const text = normalizedTranscript(this.previewText || this.finalText);
    if (!text) {
      this.fail(new XrBrowserSpeechError("no_transcript", "Speech capture ended without a transcript."), false);
      return;
    }
    if (text.length > this.maxTranscriptChars) {
      this.fail(new XrBrowserSpeechError(
        "transcript_too_long",
        `Speech transcript exceeds the ${this.maxTranscriptChars}-character limit.`,
      ), false);
      return;
    }
    this.setTerminal({
      kind: "success",
      final: Object.freeze({ text, sequence: ++this.sequence }),
    });
  }

  private fail(error: XrBrowserSpeechError, abortProvider: boolean): void {
    if (this.terminal) return;
    this.setTerminal({ kind: "error", error });
    if (abortProvider) {
      try {
        this.recognition.abort();
      } catch {
        // The first terminal outcome wins; provider cleanup errors are intentionally ignored.
      }
    }
  }

  private setTerminal(outcome: TerminalOutcome): void {
    if (this.terminal) return;
    this.terminal = outcome;
    this.cleanup();
    this.deliverTerminal();
  }

  private deliverTerminal(): void {
    if (!this.finishDeferred || !this.terminal) return;
    if (this.terminal.kind === "success") this.finishDeferred.resolve(this.terminal.final);
    else this.finishDeferred.reject(this.terminal.error);
  }

  private cleanup(): void {
    if (this.maximumTimer !== undefined) globalThis.clearTimeout(this.maximumTimer);
    if (this.finishTimer !== undefined) globalThis.clearTimeout(this.finishTimer);
    this.maximumTimer = undefined;
    this.finishTimer = undefined;
    this.request.signal.removeEventListener("abort", this.abortFromSignal);
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
    this.finalText = "";
    this.previewText = "";
    this.lastPartialText = "";
  }

  private terminalError(): XrBrowserSpeechError {
    return this.terminal?.kind === "error"
      ? this.terminal.error
      : new XrBrowserSpeechError("provider_error", "The browser speech provider failed.");
  }
}

export function probeBrowserSpeechRecognition(
  constructors: BrowserSpeechRecognitionConstructors = globalConstructors(),
): BrowserSpeechRecognitionCapability {
  const resolved = resolveProvider(constructors);
  if (!resolved) {
    return Object.freeze({
      available: false,
      provider: null,
      interimResults: false,
      requiresUserActivation: true,
      audioPersistence: "forbidden",
      transcriptPersistence: "forbidden",
      reason: "SpeechRecognition is unavailable in this browser.",
    });
  }
  return Object.freeze({
    available: true,
    provider: resolved.provider,
    interimResults: true,
    requiresUserActivation: true,
    audioPersistence: "forbidden",
    transcriptPersistence: "forbidden",
  });
}

/**
 * Optional browser speech-to-text adapter for the XR viewer.
 *
 * Construction and probe are side-effect free. `begin()` is the only method
 * that can request microphone access, so callers can invoke it directly from a
 * user gesture. The adapter never records audio, logs transcripts, or writes
 * either to persistent storage.
 */
export class BrowserSpeechRecognitionAdapter implements XrSpeechPort {
  readonly language: string;
  readonly maxDurationMs: number;
  readonly maxTranscriptChars: number;
  readonly finishGraceMs: number;
  private readonly constructors: BrowserSpeechRecognitionConstructors;
  private readonly activation: Readonly<{ isActive: boolean }> | null;
  private readonly requireActivation: boolean;

  constructor(options: BrowserSpeechRecognitionAdapterOptions = {}) {
    this.language = canonicalLanguage(options.language ?? DEFAULT_LANGUAGE);
    this.maxDurationMs = boundedInteger(
      options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      MIN_DURATION_MS,
      MAX_DURATION_MS,
      "Speech maxDurationMs",
    );
    this.maxTranscriptChars = boundedInteger(
      options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
      1,
      MAX_TRANSCRIPT_CHARS,
      "Speech maxTranscriptChars",
    );
    this.finishGraceMs = boundedInteger(
      options.finishGraceMs ?? DEFAULT_FINISH_GRACE_MS,
      0,
      MAX_FINISH_GRACE_MS,
      "Speech finishGraceMs",
    );
    this.constructors = options.constructors ?? globalConstructors();
    this.activation = options.userActivation === undefined
      ? globalUserActivation()
      : options.userActivation;
    this.requireActivation = options.requireUserActivation ?? true;
  }

  probe(): BrowserSpeechRecognitionCapability {
    return probeBrowserSpeechRecognition(this.constructors);
  }

  async begin(request: XrSpeechBeginRequest): Promise<XrSpeechCapturePort> {
    validUtteranceId(request.utteranceId);
    if (request.signal.aborted) {
      throw new XrBrowserSpeechError("aborted", "Speech capture was aborted before it began.");
    }
    if (this.requireActivation && this.activation && !this.activation.isActive) {
      throw new XrBrowserSpeechError(
        "not_user_initiated",
        "Speech capture must begin from an active user gesture.",
      );
    }
    const resolved = resolveProvider(this.constructors);
    if (!resolved) {
      throw new XrBrowserSpeechError(
        "unavailable",
        "SpeechRecognition is unavailable in this browser. Configure a provider-neutral speech port instead.",
      );
    }
    let recognition: BrowserSpeechRecognitionLike;
    try {
      recognition = new resolved.Constructor();
    } catch (cause) {
      throw new XrBrowserSpeechError(
        "provider_error",
        "The browser speech provider could not be initialized.",
        { cause },
      );
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.language;
    recognition.maxAlternatives = 1;
    const capture = new BrowserSpeechRecognitionCapture(
      recognition,
      request,
      this.maxDurationMs,
      this.maxTranscriptChars,
      this.finishGraceMs,
    );
    capture.start();
    return capture;
  }
}
