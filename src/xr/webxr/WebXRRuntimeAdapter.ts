/// <reference types="webxr" />

import type {
  XRFeature,
  XRReferenceSpaceType as SemaFrameXRReferenceSpaceType,
  XRRuntimeCapabilities,
  XRRuntimePort,
  XRSessionMode as SemaFrameXRSessionMode,
  XRSessionPort,
  XRSessionRequest,
} from "../client/contracts";

export type WebXRRuntimeAdapterOptions = Readonly<{
  navigator?: Navigator;
  runtimeId?: string;
  referenceSpacePreference?: readonly SemaFrameXRReferenceSpaceType[];
}>;

const DEFAULT_REFERENCE_SPACES: readonly SemaFrameXRReferenceSpaceType[] = Object.freeze([
  "bounded-floor",
  "local-floor",
  "local",
]);

const PROBED_FEATURES: readonly XRFeature[] = Object.freeze([
  "bounded-floor",
  "hand-tracking",
  "layers",
  "local-floor",
]);

function xrSystem(navigatorValue: Navigator | undefined): XRSystem | undefined {
  return navigatorValue && "xr" in navigatorValue
    ? (navigatorValue as Navigator & { xr?: XRSystem }).xr
    : undefined;
}

function sessionMode(mode: SemaFrameXRSessionMode): XRSessionMode {
  return mode;
}

type BrowserXRSessionFeature = NonNullable<XRSessionInit["requiredFeatures"]>[number];

function featureName(feature: XRFeature): BrowserXRSessionFeature {
  return feature;
}

function referenceSpaceType(type: SemaFrameXRReferenceSpaceType): XRReferenceSpaceType {
  return type;
}

/**
 * Browser adapter for the renderer-neutral XR lifecycle. It owns no Workspace
 * state and requests a session only from an explicit caller/user gesture.
 */
export class WebXRRuntimeAdapter implements XRRuntimePort {
  private readonly navigatorValue: Navigator | undefined;
  private readonly runtimeId: string;
  private readonly referenceSpacePreference: readonly SemaFrameXRReferenceSpaceType[];

  constructor(options: WebXRRuntimeAdapterOptions = {}) {
    this.navigatorValue = options.navigator ?? globalThis.navigator;
    this.runtimeId = options.runtimeId ?? "browser-webxr";
    this.referenceSpacePreference = options.referenceSpacePreference ?? DEFAULT_REFERENCE_SPACES;
  }

  async probe(): Promise<XRRuntimeCapabilities> {
    const xr = xrSystem(this.navigatorValue);
    if (!xr) return Object.freeze({
      runtimeId: this.runtimeId,
      available: false,
      sessionModes: Object.freeze([]),
      referenceSpaces: Object.freeze([]),
      features: Object.freeze([]),
      inputCapabilities: Object.freeze([]),
    });

    const modes: SemaFrameXRSessionMode[] = [];
    for (const mode of ["immersive-vr", "immersive-ar"] as const) {
      try {
        if (await xr.isSessionSupported(sessionMode(mode))) modes.push(mode);
      } catch {
        // A runtime may reject probing one mode while supporting the other.
      }
    }
    return Object.freeze({
      runtimeId: this.runtimeId,
      available: modes.length > 0,
      sessionModes: Object.freeze(modes),
      referenceSpaces: Object.freeze([...this.referenceSpacePreference]),
      // WebXR has no permission-free feature enumeration. These are requestable
      // feature names, not a promise that a future session grants each one.
      features: PROBED_FEATURES,
      inputCapabilities: Object.freeze(["controller", "gaze", "hand"] as const),
    });
  }

  async requestSession(request: XRSessionRequest): Promise<WebXRSessionAdapter> {
    const xr = xrSystem(this.navigatorValue);
    if (!xr) throw new Error("WebXR is unavailable in this browser");
    const session = await xr.requestSession(sessionMode(request.mode), {
      requiredFeatures: request.requiredFeatures.map(featureName),
      ...(request.optionalFeatures?.length
        ? { optionalFeatures: request.optionalFeatures.map(featureName) }
        : {}),
    });

    let grantedReferenceSpace: SemaFrameXRReferenceSpaceType | undefined;
    for (const candidate of this.referenceSpacePreference) {
      try {
        await session.requestReferenceSpace(referenceSpaceType(candidate));
        grantedReferenceSpace = candidate;
        break;
      } catch {
        // Try the next explicitly bounded fallback.
      }
    }
    if (!grantedReferenceSpace) {
      await session.end().catch(() => undefined);
      throw new Error("The XR runtime did not grant a supported reference space");
    }
    return new WebXRSessionAdapter(session, request.mode, grantedReferenceSpace);
  }
}

export class WebXRSessionAdapter implements XRSessionPort {
  readonly id: string;
  private readonly endedListeners = new Set<(reason: string) => void>();
  private ended = false;

  constructor(
    readonly rawSession: XRSession,
    readonly mode: SemaFrameXRSessionMode,
    readonly referenceSpace: SemaFrameXRReferenceSpaceType,
  ) {
    this.id = globalThis.crypto?.randomUUID?.() ?? `webxr-${Date.now().toString(36)}`;
    rawSession.addEventListener("end", this.handleEnd);
  }

  async end(): Promise<void> {
    if (this.ended) return;
    await this.rawSession.end();
  }

  onEnded(listener: (reason: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  private readonly handleEnd = (): void => {
    if (this.ended) return;
    this.ended = true;
    this.rawSession.removeEventListener("end", this.handleEnd);
    for (const listener of this.endedListeners) listener("runtime_ended");
    this.endedListeners.clear();
  };
}
