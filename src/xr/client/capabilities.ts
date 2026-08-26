import type {
  XRCapabilityDecision,
  XRCapabilityRequirement,
  XRFeature,
  XRInputCapability,
  XRReferenceSpaceType,
  XRRuntimeCapabilities,
  XRSessionMode,
} from "./contracts";
import { freezeArray } from "./math";

const SESSION_MODES = new Set<XRSessionMode>(["immersive-vr", "immersive-ar"]);
const REFERENCE_SPACES = new Set<XRReferenceSpaceType>([
  "local",
  "local-floor",
  "bounded-floor",
  "unbounded",
]);
const FEATURES = new Set<XRFeature>([
  "anchors",
  "bounded-floor",
  "depth-sensing",
  "dom-overlay",
  "hand-tracking",
  "layers",
  "local-floor",
  "unbounded",
]);
const INPUTS = new Set<XRInputCapability>(["controller", "gaze", "hand"]);

function normalizeValues<T extends string>(
  values: readonly T[],
  allowed: ReadonlySet<T>,
  label: string,
): readonly T[] {
  const unique = new Set<T>();
  for (const value of values) {
    if (!allowed.has(value)) throw new TypeError(`${label} contains unsupported value ${value}`);
    unique.add(value);
  }
  return freezeArray([...unique].sort());
}

export function normalizeXRRuntimeCapabilities(
  capabilities: XRRuntimeCapabilities,
): XRRuntimeCapabilities {
  const runtimeId = capabilities.runtimeId.trim();
  if (!runtimeId || runtimeId.length > 256) throw new TypeError("XR runtimeId is invalid");
  return Object.freeze({
    runtimeId,
    available: capabilities.available === true,
    sessionModes: normalizeValues(capabilities.sessionModes, SESSION_MODES, "sessionModes"),
    referenceSpaces: normalizeValues(capabilities.referenceSpaces, REFERENCE_SPACES, "referenceSpaces"),
    features: normalizeValues(capabilities.features, FEATURES, "features"),
    inputCapabilities: normalizeValues(capabilities.inputCapabilities, INPUTS, "inputCapabilities"),
  });
}

export function evaluateXRCapabilities(
  rawCapabilities: XRRuntimeCapabilities,
  requirement: XRCapabilityRequirement,
): XRCapabilityDecision {
  const capabilities = normalizeXRRuntimeCapabilities(rawCapabilities);
  const missing: string[] = [];
  if (!capabilities.available) missing.push("runtime");
  if (!capabilities.sessionModes.includes(requirement.mode)) missing.push(`mode:${requirement.mode}`);
  for (const feature of requirement.requiredFeatures ?? []) {
    if (!capabilities.features.includes(feature)) missing.push(`feature:${feature}`);
  }
  for (const input of requirement.requiredInputs ?? []) {
    if (!capabilities.inputCapabilities.includes(input)) missing.push(`input:${input}`);
  }
  const acceptedReferenceSpaces = requirement.acceptedReferenceSpaces ?? [];
  if (acceptedReferenceSpaces.length > 0
    && !acceptedReferenceSpaces.some((space) => capabilities.referenceSpaces.includes(space))) {
    missing.push(`reference-space:${acceptedReferenceSpaces.join("|")}`);
  }
  return Object.freeze({
    supported: missing.length === 0,
    capabilities,
    missing: freezeArray(missing),
  });
}

const CONTROLLER_VR_REQUIREMENT: XRCapabilityRequirement = {
  mode: "immersive-vr",
  requiredFeatures: ["local-floor"],
  requiredInputs: ["controller"],
  acceptedReferenceSpaces: ["local-floor", "bounded-floor"],
};

export const XR_CONTROLLER_VR_REQUIREMENT: XRCapabilityRequirement = Object.freeze({
  ...CONTROLLER_VR_REQUIREMENT,
  requiredFeatures: Object.freeze([...(CONTROLLER_VR_REQUIREMENT.requiredFeatures ?? [])]),
  requiredInputs: Object.freeze([...(CONTROLLER_VR_REQUIREMENT.requiredInputs ?? [])]),
  acceptedReferenceSpaces: Object.freeze([...(CONTROLLER_VR_REQUIREMENT.acceptedReferenceSpaces ?? [])]),
});
