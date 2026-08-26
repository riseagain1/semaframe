import type {
  XRContextEnvelope,
  XRContextEnvelopeInput,
  XRControllerRay,
  XRInputActionState,
  XRPlayerCapsule,
  XRRayHit,
  XRSpatialPin,
  XRTrackedInputInput,
  XRTrackingMetadata,
  XRTrackedInput,
} from "./contracts";
import {
  addVec3,
  finiteNumber,
  finiteVec3,
  freezeArray,
  lengthSquaredVec3,
  normalizePose,
  normalizeVec3,
  scaleVec3,
  subtractVec3,
} from "./math";

const MAX_ID_LENGTH = 256;
const MAX_TRACKED_INPUTS = 16;

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  return record;
}

function assertVec3(value: unknown, label: string): void {
  exactRecord(value, ["x", "y", "z"], ["x", "y", "z"], label);
}

function assertVec2(value: unknown, label: string): void {
  exactRecord(value, ["x", "y"], ["x", "y"], label);
}

function assertQuaternion(value: unknown, label: string): void {
  exactRecord(value, ["x", "y", "z", "w"], ["x", "y", "z", "w"], label);
}

function assertPose(value: unknown, label: string): void {
  const pose = exactRecord(value, ["position", "orientation"], ["position", "orientation"], label);
  assertVec3(pose.position, `${label}.position`);
  assertQuaternion(pose.orientation, `${label}.orientation`);
}

function assertRay(value: unknown, label: string): void {
  const ray = exactRecord(
    value,
    ["origin", "direction", "maxDistance"],
    ["origin", "direction", "maxDistance"],
    label,
  );
  assertVec3(ray.origin, `${label}.origin`);
  assertVec3(ray.direction, `${label}.direction`);
}

function assertHit(value: unknown, label: string): void {
  const hit = exactRecord(
    value,
    ["kind", "targetId", "point", "normal", "distance"],
    ["kind", "point", "normal", "distance"],
    label,
  );
  if (hit.kind !== "component" && hit.kind !== "ground" && hit.kind !== "surface") {
    throw new TypeError(`${label}.kind is invalid`);
  }
  assertVec3(hit.point, `${label}.point`);
  assertVec3(hit.normal, `${label}.normal`);
}

function assertActions(value: unknown, label: string): void {
  const actions = exactRecord(
    value,
    [
      "available", "selectPressed", "squeezePressed", "primaryButtonPressed",
      "secondaryButtonPressed", "thumbstickPressed", "thumbstick",
    ],
    [
      "available", "selectPressed", "squeezePressed", "primaryButtonPressed",
      "secondaryButtonPressed", "thumbstickPressed", "thumbstick",
    ],
    label,
  );
  assertVec2(actions.thumbstick, `${label}.thumbstick`);
}

function assertTracking(value: unknown, label: string): void {
  exactRecord(
    value,
    [
      "state", "headPoseState", "sourceTimestampMs", "sourceTimestampBasis",
      "sourceAgeMs", "sessionVisibility",
    ],
    [
      "state", "headPoseState", "sourceTimestampMs", "sourceTimestampBasis",
      "sourceAgeMs", "sessionVisibility",
    ],
    label,
  );
}

function assertContextShape(value: unknown): Record<string, unknown> {
  const body = exactRecord(value, [
    "format", "version", "ephemeral", "persistence", "source", "workspaceId",
    "workspaceRevision", "capturedAtMs", "sampleSequence", "tracking", "referenceSpace",
    "headPose", "trackedInputs", "primaryInputSourceId", "activeInputSourceId",
    "primaryRay", "rayHit", "spatialPin", "selectedComponentId", "playerCapsule",
  ], [
    "format", "version", "ephemeral", "persistence", "source", "workspaceId",
    "workspaceRevision", "capturedAtMs", "referenceSpace", "headPose", "trackedInputs",
    "playerCapsule",
  ], "XR context");
  if (body.format !== "semaframe-xr-context"
    || (body.version !== "1.0" && body.version !== "1.1" && body.version !== "1.2")
    || body.ephemeral !== true || body.persistence !== "forbidden") {
    throw new TypeError("XR context identity fields are invalid");
  }
  if (body.version === "1.0" && body.spatialPin !== undefined) {
    throw new TypeError("XR context 1.0 cannot contain spatialPin");
  }
  const hasV12TopFields = body.sampleSequence !== undefined || body.tracking !== undefined
    || body.primaryInputSourceId !== undefined || body.activeInputSourceId !== undefined;
  if (body.version !== "1.2" && hasV12TopFields) {
    throw new TypeError(`XR context ${body.version} cannot contain XR user-state 1.2 fields`);
  }
  if (body.version === "1.2"
    && (!Object.hasOwn(body, "sampleSequence") || !Object.hasOwn(body, "tracking"))) {
    throw new TypeError("XR context 1.2 requires sampleSequence and tracking");
  }
  if (body.tracking !== undefined) assertTracking(body.tracking, "XR context.tracking");
  assertPose(body.headPose, "XR context.headPose");
  if (!Array.isArray(body.trackedInputs)) throw new TypeError("XR context.trackedInputs must be an array");
  for (const [index, entry] of body.trackedInputs.entries()) {
    const label = `XR context.trackedInputs[${index}]`;
    const tracked = exactRecord(
      entry,
      [
        "sourceId", "handedness", "trackingState", "targetRayMode", "targetRayPose",
        "gripPose", "ray", "rayHit", "actions",
      ],
      body.version === "1.2"
        ? [
            "sourceId", "handedness", "trackingState", "targetRayMode", "targetRayPose",
            "actions",
          ]
        : ["sourceId", "handedness", "targetRayPose"],
      label,
    );
    const hasV12InputFields = tracked.trackingState !== undefined || tracked.targetRayMode !== undefined
      || tracked.ray !== undefined || tracked.rayHit !== undefined || tracked.actions !== undefined;
    if (body.version !== "1.2" && hasV12InputFields) {
      throw new TypeError(`XR context ${body.version} tracked inputs cannot contain 1.2 fields`);
    }
    assertPose(tracked.targetRayPose, `${label}.targetRayPose`);
    if (tracked.gripPose !== undefined) assertPose(tracked.gripPose, `${label}.gripPose`);
    if (tracked.ray !== undefined) assertRay(tracked.ray, `${label}.ray`);
    if (tracked.rayHit !== undefined) assertHit(tracked.rayHit, `${label}.rayHit`);
    if (tracked.actions !== undefined) assertActions(tracked.actions, `${label}.actions`);
  }
  if (body.primaryRay !== undefined) assertRay(body.primaryRay, "XR context.primaryRay");
  if (body.rayHit !== undefined) assertHit(body.rayHit, "XR context.rayHit");
  if (body.spatialPin !== undefined) {
    const pin = exactRecord(
      body.spatialPin,
      [
        "pinId", "pinSequence", "workspacePositionM", "surfaceNormal", "hitKind",
        "targetComponentId", "sourceId", "handedness", "placedAtMs",
        "placedAtWorkspaceRevision", "coordinateSpace", "units", "authority",
      ],
      [
        "pinId", "pinSequence", "workspacePositionM", "surfaceNormal", "hitKind",
        "sourceId", "handedness", "placedAtMs", "placedAtWorkspaceRevision",
        "coordinateSpace", "units", "authority",
      ],
      "XR context.spatialPin",
    );
    assertVec3(pin.workspacePositionM, "XR context.spatialPin.workspacePositionM");
    assertVec3(pin.surfaceNormal, "XR context.spatialPin.surfaceNormal");
  }
  const capsule = exactRecord(
    body.playerCapsule,
    ["feet", "radius", "height"],
    ["feet", "radius", "height"],
    "XR context.playerCapsule",
  );
  assertVec3(capsule.feet, "XR context.playerCapsule.feet");
  return body;
}

function boundedId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function normalizeCapsule(value: XRPlayerCapsule): XRPlayerCapsule {
  const feet = finiteVec3(value.feet, "playerCapsule.feet");
  const radius = finiteNumber(value.radius, "playerCapsule.radius");
  const height = finiteNumber(value.height, "playerCapsule.height");
  if (radius <= 0 || radius > 5) throw new RangeError("playerCapsule.radius must be in (0, 5]");
  if (height < radius * 2 || height > 10) {
    throw new RangeError("playerCapsule.height must be at least twice its radius and no more than 10");
  }
  return Object.freeze({ feet, radius, height });
}

function normalizeRay(value: XRControllerRay, label = "primaryRay"): XRControllerRay {
  const maxDistance = finiteNumber(value.maxDistance, `${label}.maxDistance`);
  if (maxDistance <= 0 || maxDistance > 1_000) {
    throw new RangeError(`${label}.maxDistance must be in (0, 1000]`);
  }
  return Object.freeze({
    origin: finiteVec3(value.origin, `${label}.origin`),
    direction: normalizeVec3(value.direction, `${label}.direction`),
    maxDistance,
  });
}

function normalizeHit(value: XRRayHit, ray?: XRControllerRay, label = "rayHit"): XRRayHit {
  if (value.kind !== "component" && value.kind !== "ground" && value.kind !== "surface") {
    throw new TypeError(`${label}.kind is invalid`);
  }
  const distance = finiteNumber(value.distance, `${label}.distance`);
  if (distance < 0 || (ray && distance > ray.maxDistance + 1e-6)) {
    throw new RangeError(`${label}.distance is outside its ray`);
  }
  if (value.kind === "component" && !value.targetId) {
    throw new TypeError(`A component ${label} requires targetId`);
  }
  const point = finiteVec3(value.point, `${label}.point`);
  if (ray) {
    const expectedPoint = addVec3(ray.origin, scaleVec3(ray.direction, distance));
    if (lengthSquaredVec3(subtractVec3(point, expectedPoint)) > 1e-6) {
      throw new RangeError(`${label}.point does not match its ray and distance`);
    }
  }
  return Object.freeze({
    kind: value.kind,
    ...(value.targetId ? { targetId: boundedId(value.targetId, `${label}.targetId`) } : {}),
    point,
    normal: normalizeVec3(value.normal, `${label}.normal`),
    distance,
  });
}

function sameVec3(left: XRRayHit["point"], right: XRRayHit["point"]): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function sameRay(left: XRControllerRay, right: XRControllerRay): boolean {
  return sameVec3(left.origin, right.origin)
    && sameVec3(left.direction, right.direction)
    && left.maxDistance === right.maxDistance;
}

function sameHit(left: XRRayHit, right: XRRayHit): boolean {
  return left.kind === right.kind
    && left.targetId === right.targetId
    && sameVec3(left.point, right.point)
    && sameVec3(left.normal, right.normal)
    && left.distance === right.distance;
}

function normalizeActions(value: XRInputActionState | undefined, index: number): XRInputActionState {
  const label = `trackedInputs[${index}].actions`;
  const source = value ?? {
    available: false,
    selectPressed: false,
    squeezePressed: false,
    primaryButtonPressed: false,
    secondaryButtonPressed: false,
    thumbstickPressed: false,
    thumbstick: { x: 0, y: 0 },
  };
  for (const field of [
    "available", "selectPressed", "squeezePressed", "primaryButtonPressed",
    "secondaryButtonPressed", "thumbstickPressed",
  ] as const) {
    if (typeof source[field] !== "boolean") throw new TypeError(`${label}.${field} must be boolean`);
  }
  const thumbstick = Object.freeze({
    x: finiteNumber(source.thumbstick.x, `${label}.thumbstick.x`),
    y: finiteNumber(source.thumbstick.y, `${label}.thumbstick.y`),
  });
  if (Math.abs(thumbstick.x) > 1 || Math.abs(thumbstick.y) > 1) {
    throw new RangeError(`${label}.thumbstick axes must be in [-1, 1]`);
  }
  if (!source.available && (source.selectPressed || source.squeezePressed
    || source.primaryButtonPressed || source.secondaryButtonPressed
    || source.thumbstickPressed || thumbstick.x !== 0 || thumbstick.y !== 0)) {
    throw new TypeError(`${label} cannot report actions when unavailable`);
  }
  return Object.freeze({
    available: source.available,
    selectPressed: source.selectPressed,
    squeezePressed: source.squeezePressed,
    primaryButtonPressed: source.primaryButtonPressed,
    secondaryButtonPressed: source.secondaryButtonPressed,
    thumbstickPressed: source.thumbstickPressed,
    thumbstick,
  });
}

function normalizeTrackedInput(value: XRTrackedInputInput, index: number): XRTrackedInput {
  if (!["left", "right", "none"].includes(value.handedness)) {
    throw new TypeError(`trackedInputs[${index}].handedness is invalid`);
  }
  const trackingState = value.trackingState ?? "unknown";
  if (!["tracked", "emulated", "unavailable", "unknown"].includes(trackingState)) {
    throw new TypeError(`trackedInputs[${index}].trackingState is invalid`);
  }
  const targetRayMode = value.targetRayMode ?? "unknown";
  if (!["gaze", "tracked-pointer", "screen", "transient-pointer", "unknown"].includes(targetRayMode)) {
    throw new TypeError(`trackedInputs[${index}].targetRayMode is invalid`);
  }
  const ray = value.ray ? normalizeRay(value.ray, `trackedInputs[${index}].ray`) : undefined;
  if (value.rayHit && !ray) throw new TypeError(`trackedInputs[${index}].rayHit requires ray`);
  if (value.trackingState !== undefined
    && (trackingState === "unknown" || trackingState === "unavailable")
    && (ray || value.rayHit || value.gripPose)) {
    throw new TypeError(`trackedInputs[${index}] cannot expose spatial evidence while tracking is ${trackingState}`);
  }
  return Object.freeze({
    sourceId: boundedId(value.sourceId, `trackedInputs[${index}].sourceId`),
    handedness: value.handedness,
    trackingState,
    targetRayMode,
    targetRayPose: normalizePose(value.targetRayPose, `trackedInputs[${index}].targetRayPose`),
    ...(value.gripPose ? { gripPose: normalizePose(value.gripPose, `trackedInputs[${index}].gripPose`) } : {}),
    ...(ray ? { ray } : {}),
    ...(value.rayHit ? {
      rayHit: normalizeHit(value.rayHit, ray, `trackedInputs[${index}].rayHit`),
    } : {}),
    actions: normalizeActions(value.actions, index),
  });
}

function normalizeTracking(
  value: XRTrackingMetadata | undefined,
): XRTrackingMetadata {
  const source = value ?? {
    state: "unknown",
    headPoseState: "unknown",
    sourceTimestampMs: 0,
    sourceTimestampBasis: "unknown",
    sourceAgeMs: 0,
    sessionVisibility: "unknown",
  };
  if (!["tracked", "limited", "lost", "unknown"].includes(source.state)) {
    throw new TypeError("tracking.state is invalid");
  }
  if (!["tracked", "emulated", "unavailable", "unknown"].includes(source.headPoseState)) {
    throw new TypeError("tracking.headPoseState is invalid");
  }
  if (!["performance-time-origin", "unix-epoch", "unknown"].includes(source.sourceTimestampBasis)) {
    throw new TypeError("tracking.sourceTimestampBasis is invalid");
  }
  if (!["visible", "visible-blurred", "hidden", "unknown"].includes(source.sessionVisibility)) {
    throw new TypeError("tracking.sessionVisibility is invalid");
  }
  const sourceTimestampMs = finiteNumber(source.sourceTimestampMs, "tracking.sourceTimestampMs");
  const sourceAgeMs = finiteNumber(source.sourceAgeMs, "tracking.sourceAgeMs");
  if (sourceTimestampMs < 0 || sourceAgeMs < 0) {
    throw new RangeError("tracking timestamps must be non-negative");
  }
  if (source.sourceTimestampBasis === "unknown" && sourceTimestampMs !== 0) {
    throw new TypeError("tracking.sourceTimestampMs must be zero when its basis is unknown");
  }
  return Object.freeze({
    state: source.state,
    headPoseState: source.headPoseState,
    sourceTimestampMs,
    sourceTimestampBasis: source.sourceTimestampBasis,
    sourceAgeMs,
    sessionVisibility: source.sessionVisibility,
  });
}

function validateTrackingConsistency(
  tracking: XRTrackingMetadata,
  trackedInputs: readonly XRTrackedInput[],
): void {
  if (tracking.sessionVisibility === "hidden" && tracking.state !== "lost") {
    throw new TypeError("hidden XR visibility requires lost aggregate tracking");
  }
  if (tracking.headPoseState === "unavailable" && tracking.state !== "lost") {
    throw new TypeError("an unavailable head pose requires lost aggregate tracking");
  }
  if (tracking.state === "tracked"
    && (tracking.headPoseState !== "tracked"
      || tracking.sessionVisibility !== "visible"
      || trackedInputs.some(({ trackingState }) => trackingState !== "tracked"))) {
    throw new TypeError("tracked aggregate state requires visible, fully tracked spatial evidence");
  }
  if (tracking.state === "limited"
    && (tracking.headPoseState === "unavailable" || tracking.sessionVisibility === "hidden")) {
    throw new TypeError("limited aggregate state cannot contain lost head or visibility evidence");
  }
}

function normalizeSpatialPin(
  value: XRSpatialPin,
  workspaceRevision: number,
  capturedAtMs: number,
): XRSpatialPin {
  const pinSequence = finiteNumber(value.pinSequence, "spatialPin.pinSequence");
  const placedAtMs = finiteNumber(value.placedAtMs, "spatialPin.placedAtMs");
  const placedAtWorkspaceRevision = finiteNumber(
    value.placedAtWorkspaceRevision,
    "spatialPin.placedAtWorkspaceRevision",
  );
  if (!Number.isSafeInteger(pinSequence) || pinSequence < 1) {
    throw new RangeError("spatialPin.pinSequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(placedAtWorkspaceRevision) || placedAtWorkspaceRevision < 0
    || placedAtWorkspaceRevision !== workspaceRevision) {
    throw new RangeError("spatialPin must belong to the current Workspace revision");
  }
  if (placedAtMs < 0 || placedAtMs > capturedAtMs) {
    throw new RangeError("spatialPin.placedAtMs must not be after the context capture");
  }
  if (value.hitKind !== "component" && value.hitKind !== "ground" && value.hitKind !== "surface") {
    throw new TypeError("spatialPin.hitKind is invalid");
  }
  if (value.hitKind === "component" && !value.targetComponentId) {
    throw new TypeError("A component spatial pin requires targetComponentId");
  }
  if (value.hitKind !== "component" && value.targetComponentId !== undefined) {
    throw new TypeError("Only a component spatial pin may contain targetComponentId");
  }
  if (!["left", "right", "none"].includes(value.handedness)) {
    throw new TypeError("spatialPin.handedness is invalid");
  }
  if (value.coordinateSpace !== "workspace-world-rub" || value.units !== "metre"
    || value.authority !== "render-interaction-estimate") {
    throw new TypeError("spatialPin coordinate authority is invalid");
  }
  return Object.freeze({
    pinId: boundedId(value.pinId, "spatialPin.pinId"),
    pinSequence,
    workspacePositionM: finiteVec3(value.workspacePositionM, "spatialPin.workspacePositionM"),
    surfaceNormal: normalizeVec3(value.surfaceNormal, "spatialPin.surfaceNormal"),
    hitKind: value.hitKind,
    ...(value.targetComponentId ? {
      targetComponentId: boundedId(value.targetComponentId, "spatialPin.targetComponentId"),
    } : {}),
    sourceId: boundedId(value.sourceId, "spatialPin.sourceId"),
    handedness: value.handedness,
    placedAtMs,
    placedAtWorkspaceRevision,
    coordinateSpace: "workspace-world-rub",
    units: "metre",
    authority: "render-interaction-estimate",
  });
}

/**
 * Snapshot deictic input against an exact Workspace revision. The result is
 * explicitly ephemeral and must never be serialized into a SemaFrame project.
 */
export function createXRContextEnvelope(input: XRContextEnvelopeInput): XRContextEnvelope {
  if (input.source !== "immersive-xr" && input.source !== "desktop-simulator") {
    throw new TypeError("source is invalid");
  }
  if (!["local", "local-floor", "bounded-floor", "unbounded"].includes(input.referenceSpace)) {
    throw new TypeError("referenceSpace is invalid");
  }
  if (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 0) {
    throw new RangeError("workspaceRevision must be a non-negative safe integer");
  }
  const capturedAtMs = finiteNumber(input.capturedAtMs, "capturedAtMs");
  if (capturedAtMs < 0) throw new RangeError("capturedAtMs must be non-negative");
  const sampleSequence = finiteNumber(input.sampleSequence ?? 0, "sampleSequence");
  if (!Number.isSafeInteger(sampleSequence) || sampleSequence < 0) {
    throw new RangeError("sampleSequence must be a non-negative safe integer");
  }
  const tracking = normalizeTracking(input.tracking);
  if (input.trackedInputs.length > MAX_TRACKED_INPUTS) {
    throw new RangeError(`trackedInputs cannot exceed ${MAX_TRACKED_INPUTS}`);
  }
  const trackedInputs = input.trackedInputs.map(normalizeTrackedInput);
  validateTrackingConsistency(tracking, trackedInputs);
  const trackedSourceIds = new Set(trackedInputs.map(({ sourceId }) => sourceId));
  if (trackedSourceIds.size !== trackedInputs.length) {
    throw new TypeError("trackedInputs sourceId values must be unique");
  }
  const primaryInputSourceId = input.primaryInputSourceId
    ? boundedId(input.primaryInputSourceId, "primaryInputSourceId")
    : undefined;
  const activeInputSourceId = input.activeInputSourceId
    ? boundedId(input.activeInputSourceId, "activeInputSourceId")
    : undefined;
  if (primaryInputSourceId && !trackedSourceIds.has(primaryInputSourceId)) {
    throw new TypeError("primaryInputSourceId must identify a tracked input");
  }
  if (activeInputSourceId && !trackedSourceIds.has(activeInputSourceId)) {
    throw new TypeError("activeInputSourceId must identify a tracked input");
  }
  const primaryRay = input.primaryRay ? normalizeRay(input.primaryRay) : undefined;
  if (input.rayHit && !primaryRay) throw new TypeError("rayHit requires primaryRay");
  const rayHit = input.rayHit ? normalizeHit(input.rayHit, primaryRay) : undefined;
  const hasExplicitV12Metadata = input.sampleSequence !== undefined
    || input.tracking !== undefined
    || input.primaryInputSourceId !== undefined
    || input.activeInputSourceId !== undefined;
  if (hasExplicitV12Metadata && Boolean(primaryInputSourceId) !== Boolean(primaryRay)) {
    throw new TypeError("primaryInputSourceId and primaryRay must be present together");
  }
  if (primaryInputSourceId) {
    const primaryInput = trackedInputs.find(({ sourceId }) => sourceId === primaryInputSourceId)!;
    if (!primaryInput.ray || !primaryRay || !sameRay(primaryInput.ray, primaryRay)) {
      throw new TypeError("primaryRay must mirror the primary tracked input ray");
    }
    if (Boolean(primaryInput.rayHit) !== Boolean(rayHit)
      || (primaryInput.rayHit && rayHit && !sameHit(primaryInput.rayHit, rayHit))) {
      throw new TypeError("rayHit must mirror the primary tracked input hit");
    }
  }
  const selectedComponentId = input.selectedComponentId
    ? boundedId(input.selectedComponentId, "selectedComponentId")
    : undefined;
  const spatialPin = input.spatialPin
    ? normalizeSpatialPin(input.spatialPin, input.workspaceRevision, capturedAtMs)
    : undefined;

  return Object.freeze({
    format: "semaframe-xr-context",
    version: "1.2",
    ephemeral: true,
    persistence: "forbidden",
    source: input.source,
    workspaceId: boundedId(input.workspaceId, "workspaceId"),
    workspaceRevision: input.workspaceRevision,
    capturedAtMs,
    sampleSequence,
    tracking,
    referenceSpace: input.referenceSpace,
    headPose: normalizePose(input.headPose, "headPose"),
    trackedInputs: freezeArray(trackedInputs),
    ...(primaryInputSourceId ? { primaryInputSourceId } : {}),
    ...(activeInputSourceId ? { activeInputSourceId } : {}),
    ...(primaryRay ? { primaryRay } : {}),
    ...(rayHit ? { rayHit } : {}),
    ...(spatialPin ? { spatialPin } : {}),
    ...(selectedComponentId ? { selectedComponentId } : {}),
    playerCapsule: normalizeCapsule(input.playerCapsule),
  });
}

/**
 * Strictly parses the untrusted JSON form received from a remote XR renderer.
 * `createXRContextEnvelope` remains the normal trusted-construction helper;
 * this parser additionally rejects unknown/missing fields at every structural
 * layer before normalizing the numeric and spatial invariants.
 */
export function parseXRContextEnvelope(value: unknown): XRContextEnvelope {
  const body = assertContextShape(value);
  return createXRContextEnvelope({
    source: body.source as XRContextEnvelopeInput["source"],
    workspaceId: body.workspaceId as string,
    workspaceRevision: body.workspaceRevision as number,
    capturedAtMs: body.capturedAtMs as number,
    ...(body.sampleSequence === undefined ? {} : { sampleSequence: body.sampleSequence as number }),
    ...(body.tracking === undefined ? {} : {
      tracking: body.tracking as XRContextEnvelopeInput["tracking"],
    }),
    referenceSpace: body.referenceSpace as XRContextEnvelopeInput["referenceSpace"],
    headPose: body.headPose as XRContextEnvelopeInput["headPose"],
    trackedInputs: body.trackedInputs as unknown as XRContextEnvelopeInput["trackedInputs"],
    ...(body.primaryInputSourceId === undefined ? {} : {
      primaryInputSourceId: body.primaryInputSourceId as string,
    }),
    ...(body.activeInputSourceId === undefined ? {} : {
      activeInputSourceId: body.activeInputSourceId as string,
    }),
    ...(body.primaryRay === undefined ? {} : {
      primaryRay: body.primaryRay as XRContextEnvelopeInput["primaryRay"],
    }),
    ...(body.rayHit === undefined ? {} : {
      rayHit: body.rayHit as XRContextEnvelopeInput["rayHit"],
    }),
    ...(body.spatialPin === undefined ? {} : {
      spatialPin: body.spatialPin as XRContextEnvelopeInput["spatialPin"],
    }),
    ...(body.selectedComponentId === undefined ? {} : {
      selectedComponentId: body.selectedComponentId as string,
    }),
    playerCapsule: body.playerCapsule as XRContextEnvelopeInput["playerCapsule"],
  });
}
