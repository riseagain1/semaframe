/// <reference types="webxr" />

import { describe, expect, it, vi } from "vitest";
import { WebXRRuntimeAdapter } from "../../xr/webxr";

function fakeSession(options: Readonly<{ rejectedSpaces?: readonly string[] }> = {}): XRSession {
  const listeners = new Set<() => void>();
  const value = {
    addEventListener: vi.fn((name: string, listener: () => void) => {
      if (name === "end") listeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)),
    requestReferenceSpace: vi.fn(async (space: string) => {
      if (options.rejectedSpaces?.includes(space)) throw new Error("unsupported");
      return {} as XRReferenceSpace;
    }),
    end: vi.fn(async () => { for (const listener of listeners) listener(); }),
  };
  return value as unknown as XRSession;
}

describe("WebXRRuntimeAdapter", () => {
  it("reports unavailable without exposing or mutating browser state", async () => {
    const adapter = new WebXRRuntimeAdapter({ navigator: {} as Navigator });
    await expect(adapter.probe()).resolves.toMatchObject({ available: false, sessionModes: [] });
  });

  it("probes modes and requests the first granted floor reference space", async () => {
    const session = fakeSession({ rejectedSpaces: ["bounded-floor"] });
    const requestSession = vi.fn(async () => session);
    const navigatorValue = {
      xr: {
        isSessionSupported: vi.fn(async (mode: string) => mode === "immersive-vr"),
        requestSession,
      },
    } as unknown as Navigator;
    const adapter = new WebXRRuntimeAdapter({ navigator: navigatorValue });
    const capability = await adapter.probe();
    expect(capability).toMatchObject({ available: true, sessionModes: ["immersive-vr"] });

    const opened = await adapter.requestSession({
      mode: "immersive-vr",
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hand-tracking"],
    });
    expect(opened.referenceSpace).toBe("local-floor");
    expect(requestSession).toHaveBeenCalledWith("immersive-vr", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hand-tracking"],
    });
  });

  it("ends a session when no supported reference space is granted", async () => {
    const session = fakeSession({ rejectedSpaces: ["bounded-floor", "local-floor", "local"] });
    const navigatorValue = {
      xr: {
        isSessionSupported: vi.fn(async () => true),
        requestSession: vi.fn(async () => session),
      },
    } as unknown as Navigator;
    const adapter = new WebXRRuntimeAdapter({ navigator: navigatorValue });
    await expect(adapter.requestSession({ mode: "immersive-vr", requiredFeatures: [] }))
      .rejects.toThrow("reference space");
    expect(session.end).toHaveBeenCalledOnce();
  });
});
