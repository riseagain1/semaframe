/**
 * Provider-neutral speech contracts for the XR viewer.
 *
 * These deliberately mirror the narrow viewer speech port structurally without
 * importing the React application. Implementations may use an on-device browser
 * recognizer or a separately supplied remote stream, but must keep audio and
 * transcripts out of Workspace persistence.
 */

export type XrSpeechPartial = Readonly<{
  text: string;
  sequence: number;
}>;

export type XrSpeechFinal = Readonly<{
  text: string;
  sequence: number;
}>;

export interface XrSpeechCapturePort {
  finish(): Promise<XrSpeechFinal>;
  cancel(reason?: string): void | Promise<void>;
}

export type XrSpeechBeginRequest = Readonly<{
  utteranceId: string;
  signal: AbortSignal;
  onPartial(partial: XrSpeechPartial): void;
}>;

export interface XrSpeechPort {
  begin(request: XrSpeechBeginRequest): Promise<XrSpeechCapturePort>;
}

export type XrSpeechOutputRequest = Readonly<{
  utteranceId: string;
  text: string;
  signal: AbortSignal;
  language?: string;
  rate?: number;
}>;

/** Provider-neutral text-to-speech output. Reply text remains renderer-local. */
export interface XrSpeechOutputPort {
  speak(request: XrSpeechOutputRequest): Promise<void>;
  stop(reason?: string): void;
}

export type XrSpeechOutputCapability = Readonly<{
  available: boolean;
  provider: string | null;
  textPersistence: "forbidden";
  reason?: string;
}>;

export type XrVoiceCue =
  | "listen_start"
  | "listen_stop"
  | "draft_ready"
  | "sent"
  | "reply_ready"
  | "error";

/** Optional non-verbal feedback. Implementations must be lazy and gesture-safe. */
export interface XrVoiceCuePort {
  play(cue: XrVoiceCue): void | Promise<void>;
  stop?(): void;
}

export type XrSpeechProviderCapability = Readonly<{
  available: boolean;
  provider: string | null;
  interimResults: boolean;
  requiresUserActivation: boolean;
  audioPersistence: "forbidden";
  transcriptPersistence: "forbidden";
  reason?: string;
}>;

/**
 * Optional provider-neutral boundary for a remote speech implementation.
 * Authentication and vendor configuration belong to the host, never this
 * contract or the XR client bundle.
 */
export interface XrRemoteSpeechProviderPort extends XrSpeechPort {
  probe(options?: Readonly<{ signal?: AbortSignal }>):
    XrSpeechProviderCapability | Promise<XrSpeechProviderCapability>;
}
