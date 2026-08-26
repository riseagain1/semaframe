import type {
  XrSpeechOutputCapability,
  XrSpeechOutputPort,
  XrSpeechOutputRequest,
} from "./contracts";

export interface BrowserSpeechSynthesisUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Readonly<{ error?: string }>) => void) | null;
}

export interface BrowserSpeechSynthesisLike {
  speak(utterance: BrowserSpeechSynthesisUtteranceLike): void;
  cancel(): void;
}

export type BrowserSpeechSynthesisAdapterOptions = Readonly<{
  synthesis?: BrowserSpeechSynthesisLike;
  createUtterance?: (text: string) => BrowserSpeechSynthesisUtteranceLike;
  language?: string;
  rate?: number;
  maximumCharacters?: number;
}>;

export class XrBrowserSpeechSynthesisError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid_request" | "aborted" | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "XrBrowserSpeechSynthesisError";
  }
}

type ActivePlayback = Readonly<{
  utterance: BrowserSpeechSynthesisUtteranceLike;
  reject(error: XrBrowserSpeechSynthesisError): void;
  cleanup(): void;
}>;

const DEFAULT_MAXIMUM_CHARACTERS = 20_000;

function browserProvider(): Readonly<{
  synthesis?: BrowserSpeechSynthesisLike;
  createUtterance?: (text: string) => BrowserSpeechSynthesisUtteranceLike;
}> {
  const root = globalThis as typeof globalThis & Readonly<{
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  }>;
  return {
    ...(root.speechSynthesis ? { synthesis: root.speechSynthesis as unknown as BrowserSpeechSynthesisLike } : {}),
    ...(typeof root.SpeechSynthesisUtterance === "function"
      ? { createUtterance: (text: string) => new root.SpeechSynthesisUtterance!(text) as unknown as BrowserSpeechSynthesisUtteranceLike }
      : {}),
  };
}

function validLanguage(value: string): string {
  try {
    const [language] = Intl.getCanonicalLocales(value.trim());
    if (!language) throw new RangeError("Missing language");
    return language;
  } catch {
    throw new XrBrowserSpeechSynthesisError("invalid_request", "Speech output language is invalid.");
  }
}

function validText(value: string, maximumCharacters: number): string {
  const text = value.normalize("NFC").trim();
  if (!text || text.length > maximumCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new XrBrowserSpeechSynthesisError(
      "invalid_request",
      `Speech output must contain 1-${maximumCharacters} safe characters.`,
    );
  }
  return text;
}

/**
 * Thin browser TTS adapter. It retains no reply history and cancels the prior
 * utterance before speaking a replacement, which makes PTT barge-in explicit.
 */
export class BrowserSpeechSynthesisAdapter implements XrSpeechOutputPort {
  readonly language: string;
  readonly rate: number;
  readonly maximumCharacters: number;
  private readonly synthesis?: BrowserSpeechSynthesisLike;
  private readonly createUtterance?: (text: string) => BrowserSpeechSynthesisUtteranceLike;
  private active?: ActivePlayback;

  constructor(options: BrowserSpeechSynthesisAdapterOptions = {}) {
    const browser = browserProvider();
    this.synthesis = options.synthesis ?? browser.synthesis;
    this.createUtterance = options.createUtterance ?? browser.createUtterance;
    this.language = validLanguage(options.language ?? globalThis.navigator?.language ?? "en-US");
    this.rate = options.rate ?? 1;
    this.maximumCharacters = options.maximumCharacters ?? DEFAULT_MAXIMUM_CHARACTERS;
    if (!Number.isFinite(this.rate) || this.rate < 0.5 || this.rate > 2) {
      throw new XrBrowserSpeechSynthesisError("invalid_request", "Speech output rate must be between 0.5 and 2.");
    }
    if (!Number.isSafeInteger(this.maximumCharacters)
      || this.maximumCharacters < 1
      || this.maximumCharacters > DEFAULT_MAXIMUM_CHARACTERS) {
      throw new XrBrowserSpeechSynthesisError(
        "invalid_request",
        `Speech output maximumCharacters must be between 1 and ${DEFAULT_MAXIMUM_CHARACTERS}.`,
      );
    }
  }

  probe(): XrSpeechOutputCapability {
    if (!this.synthesis || !this.createUtterance) {
      return Object.freeze({
        available: false,
        provider: null,
        textPersistence: "forbidden",
        reason: "SpeechSynthesis is unavailable in this browser.",
      });
    }
    return Object.freeze({
      available: true,
      provider: "speech-synthesis",
      textPersistence: "forbidden",
    });
  }

  speak(request: XrSpeechOutputRequest): Promise<void> {
    if (!this.synthesis || !this.createUtterance) {
      return Promise.reject(new XrBrowserSpeechSynthesisError(
        "unavailable",
        "SpeechSynthesis is unavailable in this browser.",
      ));
    }
    if (request.signal.aborted) {
      return Promise.reject(new XrBrowserSpeechSynthesisError("aborted", "Speech output was cancelled."));
    }
    const text = validText(request.text, this.maximumCharacters);
    const language = validLanguage(request.language ?? this.language);
    const rate = request.rate ?? this.rate;
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      return Promise.reject(new XrBrowserSpeechSynthesisError(
        "invalid_request",
        "Speech output rate must be between 0.5 and 2.",
      ));
    }
    this.stop("replaced");
    const utterance = this.createUtterance(text);
    utterance.text = text;
    utterance.lang = language;
    utterance.rate = rate;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        request.signal.removeEventListener("abort", abort);
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.active?.utterance === utterance) this.active = undefined;
      };
      const settle = (error?: XrBrowserSpeechSynthesisError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        this.synthesis?.cancel();
        settle(new XrBrowserSpeechSynthesisError("aborted", "Speech output was cancelled."));
      };
      utterance.onend = () => settle();
      utterance.onerror = () => settle(new XrBrowserSpeechSynthesisError(
        "provider_error",
        "The browser speech output provider failed.",
      ));
      request.signal.addEventListener("abort", abort, { once: true });
      this.active = Object.freeze({
        utterance,
        reject: (error) => settle(error),
        cleanup,
      });
      try {
        this.synthesis!.speak(utterance);
      } catch {
        settle(new XrBrowserSpeechSynthesisError(
          "provider_error",
          "The browser speech output provider could not start.",
        ));
      }
    });
  }

  stop(_reason = "stopped"): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.synthesis?.cancel();
    active.reject(new XrBrowserSpeechSynthesisError("aborted", "Speech output was cancelled."));
  }
}
