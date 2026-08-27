import type {
  ComponentPlacement,
  ComponentTypeRef,
  ComponentVisibility,
  JSONObject,
  JSONSchema,
} from "../workspace/components/componentTypes";
import type { TransitionSpec } from "../workspace/protocol/workspaceTypes";

export const SEMAFRAME_EXCHANGE_FORMAT = "semaframe-scene-exchange" as const;
export const SEMAFRAME_EXCHANGE_VERSION = "1.0" as const;
export const SEMAFRAME_CHANGE_PROPOSAL_FORMAT = "semaframe-bridge-change-proposal" as const;
export const SEMAFRAME_CHANGE_PROPOSAL_VERSION = "1.0" as const;

export const SEMAFRAME_EXCHANGE_PATHS = Object.freeze({
  manifest: "semaframe.exchange.json",
  report: "fidelity-report.json",
  openUsd: "scene.usda",
  glb: "geometry.glb",
  exactStep: "exact/model.step",
});

export const SEMAFRAME_EXCHANGE_LIMITS = Object.freeze({
  maximumComponents: 10_000,
  maximumConnections: 20_000,
  maximumResources: 5_000,
  maximumProposalChanges: 100,
  maximumProposalBytes: 1_048_576,
  maximumTextLength: 2_000,
});

export type SemaFrameSha256 = `sha256:${string}`;

export type SemaFrameBridgeTarget =
  | "blender"
  | "freecad"
  | "unity"
  | "unreal"
  | "custom";

export type SemaFrameExchangeArtifact = Readonly<{
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: SemaFrameSha256;
}>;

export type SemaFrameExchangeAction = Readonly<{
  name: string;
  inputSchema: JSONSchema;
  effectClass: "none" | "semantic" | "data_read" | "external_write" | "extension_install";
  routable: boolean;
}>;

export type SemaFrameExchangeEvent = Readonly<{
  name: string;
  payloadSchema: JSONSchema;
}>;

export type SemaFrameExchangeNode = Readonly<{
  stableId: string;
  parentStableId?: string;
  componentType: ComponentTypeRef;
  label: string;
  placement: ComponentPlacement;
  visibility: ComponentVisibility;
  tags: readonly string[];
  actions: readonly SemaFrameExchangeAction[];
  events: readonly SemaFrameExchangeEvent[];
  representation:
    | "exact_brep"
    | "parametric_mesh"
    | "reality_asset"
    | "semantic_only";
  usdPrimPath?: string;
  gltfNodeIndex?: number;
}>;

export type SemaFrameExchangeResource = Readonly<{
  id: string;
  label: string;
  connectorType: string;
  connectorVersion: string;
  outputSchema: JSONSchema;
  status: "unconfigured" | "ready" | "stale" | "error";
  /** Snapshot values, connector configuration, secret handles and errors never cross this boundary. */
  exportedData: false;
}>;

export type SemaFrameExchangeConnection = Readonly<{
  id: string;
  kind: "resource_binding" | "event_connection";
  sourceId: string;
  targetComponentId: string;
  sourceSignal: string;
  targetInput: string;
  enabled: boolean;
}>;

export type SemaFrameExchangeManifest = Readonly<{
  format: typeof SEMAFRAME_EXCHANGE_FORMAT;
  version: typeof SEMAFRAME_EXCHANGE_VERSION;
  generator: Readonly<{ name: "SemaFrame"; version: string }>;
  source: Readonly<{
    workspaceId: string;
    revision: number;
    workspaceDigest: SemaFrameSha256;
    registryDigest: string;
  }>;
  coordinateSystem: Readonly<{
    units: "metre";
    handedness: "right";
    upAxis: "Y";
    angles: "radian";
  }>;
  nodes: readonly SemaFrameExchangeNode[];
  resources: readonly SemaFrameExchangeResource[];
  connections: readonly SemaFrameExchangeConnection[];
  files: readonly SemaFrameExchangeArtifact[];
  roundTrip: Readonly<{
    stableIds: true;
    directMutation: false;
    editsReturnAs: "reviewable_change_proposal";
  }>;
}>;

export type SemaFrameFidelityItem = Readonly<{
  componentId: string;
  level: "exact" | "parametric" | "visual" | "semantic";
  exportedTo: readonly ("openusd" | "glb" | "step" | "manifest")[];
  limitations: readonly string[];
}>;

export type SemaFrameFidelityReport = Readonly<{
  format: "semaframe-fidelity-report";
  version: typeof SEMAFRAME_EXCHANGE_VERSION;
  outcome: "passed" | "passed_with_limitations";
  source: SemaFrameExchangeManifest["source"];
  items: readonly SemaFrameFidelityItem[];
  summary: Readonly<{
    exact: number;
    parametric: number;
    visual: number;
    semantic: number;
  }>;
  limitations: readonly string[];
}>;

export type SemaFrameExchangeFile = SemaFrameExchangeArtifact & Readonly<{
  bytes: Uint8Array;
}>;

export type SemaFrameExchangePackage = Readonly<{
  format: "semaframe-exchange-package";
  version: typeof SEMAFRAME_EXCHANGE_VERSION;
  archive: SemaFrameExchangeFile;
  files: readonly SemaFrameExchangeFile[];
  manifest: SemaFrameExchangeManifest;
  report: SemaFrameFidelityReport;
}>;

export type SemaFrameTransformChange = Readonly<{
  changeId: string;
  kind: "transform";
  componentId: string;
  placement: ComponentPlacement;
  transition?: TransitionSpec;
}>;

export type SemaFramePropertiesChange = Readonly<{
  changeId: string;
  kind: "properties";
  componentId: string;
  /** Writable top-level props patch, applied with WorkspaceStore's shallow patch semantics. */
  props: JSONObject;
}>;

export type SemaFramePresentationChange = Readonly<{
  changeId: string;
  kind: "presentation";
  componentId: string;
  label?: string;
  visibility?: ComponentVisibility;
  tags?: readonly string[];
}>;

export type SemaFrameHierarchyChange = Readonly<{
  changeId: string;
  kind: "hierarchy";
  componentId: string;
  parentComponentId?: string;
  transformMode: "preserve_local" | "preserve_world";
}>;

export type SemaFrameBridgeChange =
  | SemaFrameTransformChange
  | SemaFramePropertiesChange
  | SemaFramePresentationChange
  | SemaFrameHierarchyChange;

export type SemaFrameBridgeChangeProposal = Readonly<{
  format: typeof SEMAFRAME_CHANGE_PROPOSAL_FORMAT;
  version: typeof SEMAFRAME_CHANGE_PROPOSAL_VERSION;
  proposalId: string;
  target: SemaFrameBridgeTarget;
  source: Readonly<{
    workspaceId: string;
    baseRevision: number;
    exchangeDigest: SemaFrameSha256;
  }>;
  changes: readonly SemaFrameBridgeChange[];
  note?: string;
}>;

export type SemaFrameBridgeProposalReview = Readonly<{
  proposal: SemaFrameBridgeChangeProposal;
  status: "review_required";
  stale: boolean;
  issues: readonly Readonly<{
    changeId?: string;
    code: string;
    message: string;
  }>[];
  eligibleChangeIds: readonly string[];
  ineligibleChangeIds: readonly string[];
}>;
