/**
 * Renderer- and vendor-neutral contracts for an immersive SemaFrame client.
 * Browser adapters may implement these ports with WebXR, but this core never
 * reads `navigator.xr` or creates a second Workspace authority.
 */

export type XRVec2 = Readonly<{ x: number; y: number }>;
export type XRVec3 = Readonly<{ x: number; y: number; z: number }>;
export type XRQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;
export type XRPose = Readonly<{ position: XRVec3; orientation: XRQuaternion }>;

export type XRSessionMode = "immersive-vr" | "immersive-ar";
export type XRReferenceSpaceType = "local" | "local-floor" | "bounded-floor" | "unbounded";
export type XRFeature =
  | "anchors"
  | "bounded-floor"
  | "depth-sensing"
  | "dom-overlay"
  | "hand-tracking"
  | "layers"
  | "local-floor"
  | "unbounded";

export type XRInputCapability = "controller" | "gaze" | "hand";

export type XRRuntimeCapabilities = Readonly<{
  runtimeId: string;
  available: boolean;
  sessionModes: readonly XRSessionMode[];
  referenceSpaces: readonly XRReferenceSpaceType[];
  features: readonly XRFeature[];
  inputCapabilities: readonly XRInputCapability[];
}>;

export type XRSessionRequest = Readonly<{
  mode: XRSessionMode;
  requiredFeatures: readonly XRFeature[];
  optionalFeatures?: readonly XRFeature[];
}>;

export interface XRSessionPort {
  readonly id: string;
  readonly mode: XRSessionMode;
  readonly referenceSpace: XRReferenceSpaceType;
  end(): Promise<void>;
  onEnded(listener: (reason: string) => void): () => void;
}

export interface XRRuntimePort {
  probe(): Promise<XRRuntimeCapabilities>;
  requestSession(request: XRSessionRequest): Promise<XRSessionPort>;
}

export type XRCapabilityRequirement = Readonly<{
  mode: XRSessionMode;
  requiredFeatures?: readonly XRFeature[];
  requiredInputs?: readonly XRInputCapability[];
  acceptedReferenceSpaces?: readonly XRReferenceSpaceType[];
}>;

export type XRCapabilityDecision = Readonly<{
  supported: boolean;
  capabilities: XRRuntimeCapabilities;
  missing: readonly string[];
}>;

export type XRHandedness = "left" | "right" | "none";
export type XRInputTrackingState = "tracked" | "emulated" | "unavailable" | "unknown";
export type XRTargetRayMode = "gaze" | "tracked-pointer" | "screen" | "transient-pointer" | "unknown";
export type XRUserTrackingState = "tracked" | "limited" | "lost" | "unknown";
export type XRSessionVisibilityState = "visible" | "visible-blurred" | "hidden" | "unknown";
export type XRSourceTimestampBasis = "performance-time-origin" | "unix-epoch" | "unknown";

export type XRControllerRay = Readonly<{
  origin: XRVec3;
  direction: XRVec3;
  maxDistance: number;
}>;

export type XRAabb = Readonly<{
  min: XRVec3;
  max: XRVec3;
}>;

export type XRRayHitKind = "component" | "ground" | "surface";

export type XRRayHit = Readonly<{
  kind: XRRayHitKind;
  targetId?: string;
  point: XRVec3;
  normal: XRVec3;
  distance: number;
}>;

/**
 * A deliberately small, semantic action surface for an Agent. Raw Gamepad
 * button/axis arrays never cross the XR context boundary. `available: false`
 * means the remaining neutral values are placeholders, not observed input.
 */
export type XRInputActionState = Readonly<{
  available: boolean;
  selectPressed: boolean;
  squeezePressed: boolean;
  primaryButtonPressed: boolean;
  secondaryButtonPressed: boolean;
  thumbstickPressed: boolean;
  thumbstick: XRVec2;
}>;

export type XRTrackedInput = Readonly<{
  sourceId: string;
  handedness: XRHandedness;
  trackingState: XRInputTrackingState;
  targetRayMode: XRTargetRayMode;
  targetRayPose: XRPose;
  gripPose?: XRPose;
  ray?: XRControllerRay;
  rayHit?: XRRayHit;
  actions: XRInputActionState;
}>;

/** Timing and tracking health for one renderer-authored XR sample. */
export type XRTrackingMetadata = Readonly<{
  state: XRUserTrackingState;
  headPoseState: XRInputTrackingState;
  sourceTimestampMs: number;
  sourceTimestampBasis: XRSourceTimestampBasis;
  sourceAgeMs: number;
  sessionVisibility: XRSessionVisibilityState;
}>;

/**
 * One user-placed, renderer-owned reference point. The numeric point is kept at
 * full precision in SemaFrame Workspace world coordinates; any label rendered
 * in the headset is presentation-only and may be rounded for readability.
 */
export type XRSpatialPin = Readonly<{
  pinId: string;
  pinSequence: number;
  workspacePositionM: XRVec3;
  surfaceNormal: XRVec3;
  hitKind: XRRayHitKind;
  targetComponentId?: string;
  sourceId: string;
  handedness: XRHandedness;
  placedAtMs: number;
  placedAtWorkspaceRevision: number;
  coordinateSpace: "workspace-world-rub";
  units: "metre";
  authority: "render-interaction-estimate";
}>;

/** A vertical capsule whose position is the centre of its bottom point. */
export type XRPlayerCapsule = Readonly<{
  feet: XRVec3;
  radius: number;
  height: number;
}>;

/**
 * Renderer-owned, ephemeral spatial facts captured at one instant. The viewer
 * adds Workspace identity/revision before this can cross the authority
 * boundary as an XRContextEnvelope.
 */
export type XRSpatialContextSnapshot = Readonly<{
  sampleSequence: number;
  tracking: XRTrackingMetadata;
  referenceSpace: Exclude<XRReferenceSpaceType, "unbounded">;
  headPose: XRPose;
  trackedInputs: readonly XRTrackedInput[];
  primaryInputSourceId?: string;
  activeInputSourceId?: string;
  primaryRay?: XRControllerRay;
  rayHit?: XRRayHit;
  spatialPin?: XRSpatialPin;
  playerCapsule: XRPlayerCapsule;
}>;

export type XRContextEnvelope = Readonly<{
  format: "semaframe-xr-context";
  version: "1.0" | "1.1" | "1.2";
  ephemeral: true;
  persistence: "forbidden";
  source: "immersive-xr" | "desktop-simulator";
  workspaceId: string;
  workspaceRevision: number;
  capturedAtMs: number;
  sampleSequence: number;
  tracking: XRTrackingMetadata;
  referenceSpace: XRReferenceSpaceType;
  headPose: XRPose;
  trackedInputs: readonly XRTrackedInput[];
  primaryInputSourceId?: string;
  activeInputSourceId?: string;
  primaryRay?: XRControllerRay;
  rayHit?: XRRayHit;
  spatialPin?: XRSpatialPin;
  selectedComponentId?: string;
  playerCapsule: XRPlayerCapsule;
}>;

export type XRTrackedInputInput = Readonly<
  Omit<XRTrackedInput, "trackingState" | "targetRayMode" | "actions">
  & Partial<Pick<XRTrackedInput, "trackingState" | "targetRayMode" | "actions">>
>;

/**
 * Construction accepts omitted v1.2 metadata so legacy in-process callers can
 * be upgraded without inventing observed tracking/action facts. The emitted
 * envelope is always a complete v1.2 value with explicit `unknown`/unavailable
 * markers.
 */
export type XRContextEnvelopeInput = Readonly<
  Omit<
    XRContextEnvelope,
    | "format"
    | "version"
    | "ephemeral"
    | "persistence"
    | "sampleSequence"
    | "tracking"
    | "trackedInputs"
  >
  & {
    sampleSequence?: number;
    tracking?: XRTrackingMetadata;
    trackedInputs: readonly XRTrackedInputInput[];
  }
>;

export type XRNormalizedInputFrame = Readonly<{
  source: "desktop-simulator" | "immersive-xr";
  timestampMs: number;
  headPose: XRPose;
  primaryRay?: XRControllerRay;
  move: XRVec2;
  snapTurn: -1 | 0 | 1;
  pushToTalkPressed: boolean;
  selectPressed: boolean;
  cancelPressed: boolean;
}>;

export interface XRInputFramePort {
  readFrame(timestampMs: number): XRNormalizedInputFrame;
}
