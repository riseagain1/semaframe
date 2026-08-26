import { describe, expect, it, vi } from "vitest";
import {
  BrowserSpeechSynthesisAdapter,
  type BrowserSpeechSynthesisUtteranceLike,
} from "../../xr/speech";

function utterance(text: string): BrowserSpeechSynthesisUtteranceLike {
  return {
    text,
    lang: "",
    rate: 1,
    onstart: null,
    onend: null,
    onerror: null,
  };
}

describe("BrowserSpeechSynthesisAdapter", () => {
  it("speaks bounded reply text once without retaining a history", async () => {
    let active: BrowserSpeechSynthesisUtteranceLike | undefined;
    const synthesis = {
      speak: vi.fn((value: BrowserSpeechSynthesisUtteranceLike) => { active = value; }),
      cancel: vi.fn(),
    };
    const adapter = new BrowserSpeechSynthesisAdapter({
      synthesis,
      createUtterance: utterance,
      language: "en-US",
    });
    const abort = new AbortController();
    const completion = adapter.speak({
      utteranceId: "reply-1",
      text: "The scene is ready.",
      signal: abort.signal,
    });
    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect(active).toMatchObject({ text: "The scene is ready.", lang: "en-US", rate: 1 });
    active?.onend?.();
    await expect(completion).resolves.toBeUndefined();
  });

  it("cancels active speech for PTT barge-in and settles the pending output", async () => {
    const synthesis = { speak: vi.fn(), cancel: vi.fn() };
    const adapter = new BrowserSpeechSynthesisAdapter({ synthesis, createUtterance: utterance });
    const pending = adapter.speak({
      utteranceId: "reply-2",
      text: "A longer Agent reply",
      signal: new AbortController().signal,
    });
    adapter.stop("ptt_barge_in");
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });

  it("is side-effect free when the browser provider is unavailable", async () => {
    const adapter = new BrowserSpeechSynthesisAdapter({
      synthesis: undefined,
      createUtterance: undefined,
    });
    if (globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance) return;
    expect(adapter.probe()).toMatchObject({ available: false, textPersistence: "forbidden" });
    await expect(adapter.speak({
      utteranceId: "reply-3",
      text: "Nothing should play",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "unavailable" });
  });
});
