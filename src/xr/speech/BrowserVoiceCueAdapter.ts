import type { XrVoiceCue, XrVoiceCuePort } from "./contracts";

type AudioContextConstructor = new () => AudioContext;

export type BrowserVoiceCueAdapterOptions = Readonly<{
  audioContextConstructor?: AudioContextConstructor;
  volume?: number;
}>;

const PATTERNS: Readonly<Record<XrVoiceCue, readonly Readonly<{
  frequency: number;
  durationMs: number;
  delayMs: number;
}>[]>> = Object.freeze({
  listen_start: [{ frequency: 620, durationMs: 55, delayMs: 0 }],
  listen_stop: [{ frequency: 470, durationMs: 45, delayMs: 0 }],
  draft_ready: [
    { frequency: 620, durationMs: 55, delayMs: 0 },
    { frequency: 820, durationMs: 65, delayMs: 85 },
  ],
  sent: [{ frequency: 880, durationMs: 90, delayMs: 0 }],
  reply_ready: [
    { frequency: 740, durationMs: 70, delayMs: 0 },
    { frequency: 980, durationMs: 90, delayMs: 100 },
  ],
  error: [
    { frequency: 250, durationMs: 80, delayMs: 0 },
    { frequency: 190, durationMs: 110, delayMs: 105 },
  ],
});

function browserAudioContext(): AudioContextConstructor | undefined {
  const root = globalThis as typeof globalThis & Readonly<{
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  }>;
  return root.AudioContext ?? root.webkitAudioContext;
}

/** Lazy synthetic cues: construction and the disabled path never touch audio. */
export class BrowserVoiceCueAdapter implements XrVoiceCuePort {
  private readonly Context?: AudioContextConstructor;
  private readonly volume: number;
  private context?: AudioContext;

  constructor(options: BrowserVoiceCueAdapterOptions = {}) {
    this.Context = options.audioContextConstructor ?? browserAudioContext();
    this.volume = options.volume ?? 0.08;
    if (!Number.isFinite(this.volume) || this.volume < 0 || this.volume > 0.25) {
      throw new RangeError("Voice cue volume must be between 0 and 0.25.");
    }
  }

  async play(cue: XrVoiceCue): Promise<void> {
    if (!this.Context || this.volume === 0) return;
    const context = this.context ?? new this.Context();
    this.context = context;
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    const start = context.currentTime;
    for (const note of PATTERNS[cue]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + note.delayMs / 1_000;
      const noteEnd = noteStart + note.durationMs / 1_000;
      oscillator.type = cue === "error" ? "square" : "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, this.volume), noteStart + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.01);
    }
  }

  stop(): void {
    // Cues are intentionally sub-250 ms and self-terminating. Suspending the
    // shared context here would make the next user-gesture cue unreliable.
  }
}
