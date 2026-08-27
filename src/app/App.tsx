import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  AgentGatewayClient,
  AgentGatewayCommandError,
  AgentGatewayError,
  type AgentGatewayCommandHandler,
  type AgentGatewayConfig,
  type AgentGatewayStatus,
  type AgentBridgeProposalRecord,
  type AgentBridgeSessionAccess,
  type PhotoReconstructionCapability,
} from "../agent/AgentGatewayClient";
import {
  AgentHostControlCoordinator,
  AgentHostControlError,
} from "../agent/AgentHostControlCoordinator";
import { HostActionLedger, HostActionLedgerError } from "../agent/HostActionLedger";
import type { RequiredUserAction, XrHostPhase } from "../agent/hostControlContracts";
import {
  VoiceRelayHttpClient,
  VOICE_RELAY_HOST_ACTION_HEADER,
  VOICE_RELAY_HTTP_PATHS,
  type VoiceRelayStatus,
  type VoiceRelayDiagnosticReport,
  type VoiceRelaySetupPreparation,
  type VoiceRelayTargetCandidate,
} from "../voice-relay";
import { ConfirmDialog } from "./components/ConfirmDialog";
import {
  HostActionPrompt,
  type HostActionPromptRequest,
} from "./components/HostActionPrompt";
import { isRemoteXrContextFresh, remoteXrContextKnownAgeMs } from "./xrContextFreshness";
import { VoiceRelaySettingsDialog } from "./components/VoiceRelaySettingsDialog";
import {
  AgentConnectionPage,
  type AgentConnectionClient,
  type AgentConnectionPageProps,
} from "./components/AgentConnectionPage";
import {
  deriveAgentExperienceState,
  type AgentConfigPhase,
} from "./agentExperience";
import {
  isAgentWorkspaceUnlocked,
  quiesceAgentBridgeForProjectReplacement,
  replaceAgentOfferAndRestoreBridge,
  restoreAgentBrowserBridge,
  shouldClearRealityMeasurementForWorkspaceGate,
  stopXrSessionsForProjectReplacement,
} from "./lifecycle";
import { AgentWorkspaceGate } from "./components/AgentWorkspaceGate";
import { statusLabel } from "./components/StatusPill";
import type { HybridWorkspaceCanvasHandle } from "./components/workspace/HybridWorkspaceCanvas";
import type {
  XRWorkspaceButtonHandle,
  XRWorkspaceButtonPhase,
} from "./components/XRWorkspaceButton";
import type {
  XRHeadsetSessionButtonHandle,
  XRHeadsetSessionPhase,
} from "./components/XRHeadsetSessionButton";
import { XRSetupAssistant } from "./components/XRSetupAssistant";
import type {
  WorkspaceComponentResizeRequest,
  WorkspaceComponentHierarchyRequest,
  WorkspaceComponentTransformRequest,
  WorkspaceComponentUpdateRequest,
  WorkspaceComponentVisualEffectsRequest,
} from "./components/workspace/WorkspaceInspector";
import type { ComponentCreationOptions } from "./components/workspace/WorkspaceComponentLibrary";
import type { WorkspacePanel } from "./components/workspace/WorkspaceChrome";
import { WorkspaceStartPanel } from "./components/workspace/WorkspaceStartPanel";
import {
  buildWorkspaceValidationView,
  type WorkspaceValidationTarget,
} from "./validation/buildWorkspaceValidationView";
import { buildWorkspaceComponentCatalog } from "./components/workspace/modelingCatalog";
import type {
  WorkspaceModelExportAction,
  WorkspaceModelHierarchyItem,
  WorkspaceModelPublishRequest,
} from "./components/workspace/WorkspaceModelLibrary";
import {
  planWorkspaceModelInstance,
  WorkspaceModelExportGate,
} from "./components/workspace/workspaceModelActions";
import type {
  WorkspaceInlineSourceSaveRequest,
  WorkspaceSourceAtomicCreateRequest,
} from "./components/workspace/WorkspaceSourcePanel";
import { planWorkspaceSourceAtomicCreate } from "./workspaceSourceAtomicCreate";
import type {
  RealityAssetAvailability,
  WorkspaceRealityAssetItem,
} from "./components/workspace/WorkspaceRealityAssets";
import type { AppNotice, WorkspaceHistoryEntry, WorkspaceHistoryStatus } from "./uiTypes";
import {
  WorkspaceAgentCommandRouter,
  WorkspaceAgentController,
  WorkspaceStoreEngineAdapter,
  type WorkspacePermissionScope,
} from "../workspace/agents";
import {
  DEFAULT_COMPONENT_REGISTRY,
  resizePolicyForPlacement,
  type ComponentInstance,
  type ComponentManifest,
  type ComponentPlacement,
  type JSONObject,
} from "../workspace/components";
import { createXRContextEnvelope, type XRContextEnvelope } from "../xr/client";
import { toXrWorkspaceProjection } from "../xr/authority";
import { deriveXrViewerPanelModels, presentXrWorldPanels } from "../xr/app/panels";
import { resizeCommitOperations } from "../workspace/interaction";
import {
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
} from "../workspace/protocol";
import {
  MAX_WORKSPACE_COMPONENTS,
  MAX_WORKSPACE_PROJECT_BYTES,
  WorkspaceStore,
  type WorkspaceState,
} from "../workspace/state";
import {
  findAvailableLayoutPlacement,
  planAutoArrangeLayout,
} from "../workspace/layout";
import {
  localPlacementForWorldTransform,
  resolveComponentWorldTransform,
} from "../workspace/state/worldTransform";
import {
  HOST_FEED_CONNECTOR_TYPE,
  HOST_FEED_CONNECTOR_VERSION,
  isCanonicalHostFeedResource,
  isCanonicalInlineSnapshotResource,
  parseLocalInlineSource,
  type HostFeedFetchRequest,
  type HostFeedFetchResponse,
  type HostFeedFormat,
  type ResourceBinding,
  type WorkspaceHostFeedPreviewRequest,
  type WorkspaceHostFeedSaveRequest,
  type WorkspaceResource,
} from "../workspace/data";
import {
  toRenderSnapshot,
  type AnimationCompletionRequest,
  type ComponentActivationRequest,
  type ComponentActionRequest,
  type PlacementCommitRequest,
  type ResizeCommitRequest,
  type WorkspaceRenderComponent,
} from "../workspace/renderer/contracts";
import {
  verifyWorkspaceProjectCadEvidence,
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../workspace/persistence";
import {
  createPortableProjectBundle,
  importWorkspaceProjectArtifact,
  PORTABLE_PROJECT_EXTENSION,
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MEDIA_TYPE,
} from "../workspace/persistence/portable";
import { createSemaFrameExchange } from "../bridge";
import {
  approvedBridgeChangesToWorkspaceOperations,
  reviewSemaFrameBridgeProposal,
  type SemaFrameBridgeTarget,
  type SemaFrameSha256,
} from "../bridge";
import type {
  SceneBridgeProposalItem,
  SceneBridgePublicationSummary,
} from "./components/SceneBridgeDialog";
import {
  planWorkspaceTimerSignals,
  workspaceAnimationCompletionAction,
} from "./workspaceHostSignals";
import {
  hostFeedRetryDelayMs,
  nextHostFeedRefreshDelayMs,
} from "./hostFeedRefreshPolicy";
import {
  HostFeedAutomationConsentLedger,
  hostFeedAutomationPaused,
  hostFeedRefreshAllowed,
  type HostFeedAutomationDescriptor,
} from "./hostFeedAutomationConsent";
import { buildPhysicsValidationReport } from "../workspace/physics";
import { buildSemaFrameSpatialGraph } from "../workspace/spatial";
import {
  deriveParametricBounds,
  createModelDefinitionCadHandoffPackageInWorker,
  exportModelDefinitionCsgArtifactInWorker,
  exportModelDefinitionToStep,
  exportParametricModelToUsda,
  modelDefinitionCsgCompatibility,
  modelDefinitionCadHandoffCompatibility,
  modelDefinitionStepCompatibility,
  modelDefinitionRef,
  modelDefinitionToOpenUsdDocument,
  parseParametricPrimitive,
  type ModelDefinition,
} from "../workspace/modeling";
import { historyEntriesForStore } from "./workspaceHistory";
import { safeStorageGet, safeStorageRemove } from "./browserStorage";
import {
  FallbackWorkspaceRecoveryRepository,
  IndexedDbWorkspaceRecoveryRepository,
  LocalStorageWorkspaceRecoveryRepository,
  WorkspaceRecoveryCoordinator,
} from "./recovery";
import {
  assertRealityAssetCandidatePurpose,
  PhotoReconstructionCancellationTracker,
  RetainedRealityAssetCandidateError,
  RealityAssetCompletionLedger,
  type RealityAssetCandidatePurpose,
  type RealityAssetCompletionSource,
  type TrackedPhotoReconstruction,
} from "./realityAssetCompletion";
import {
  BrowserAssetVault,
  digestBlobSha256,
  MemoryAssetVault,
  RealityAssetError,
  preflightRealityAssetInWorker,
  type AssetVault,
  type RealityAssetCandidate,
  type RealityAssetDescriptor,
} from "../workspace/assets";
import {
  PHOTO_RECONSTRUCTION_LIMITS,
  PHOTO_RECONSTRUCTION_MEDIA_TYPES,
  type PhotoReconstructionJobView,
  type PhotoReconstructionMediaType,
  type PhotoReconstructionProfile,
} from "../reconstruction/contracts";
import type { RealityMeasurementEvent } from "../renderer/reality";
import type { ThreeRendererXRPanelAction } from "../renderer/xr";

const RECOVERY_KEY = "semaframe-workspace-recovery-v2";
const AGENT_CONTROL_ENDPOINT = import.meta.env.VITE_AGENT_CONTROL_ENDPOINT?.trim() || "/api/agent";
const AGENT_BROWSER_INSTANCE_KEY = "semaframe-agent-browser-v1";
const MAX_VISIBLE_HISTORY_ENTRIES = 256;

type AppRealityAssetVault = Readonly<{
  vault: AssetVault;
  persistent: boolean;
}>;

type AppRealityAssetCompletion = Readonly<{
  requestId: string;
  inputRevision: number;
  purpose: RealityAssetCandidatePurpose;
  descriptor: RealityAssetDescriptor;
  result: JSONObject;
}>;

function createAppRealityAssetVault(): AppRealityAssetVault {
  try {
    return { vault: new BrowserAssetVault(), persistent: true };
  } catch {
    // Non-browser/test/private hosts still get the exact same content-addressed
    // safety boundary, but bytes last only for this App lifetime.
    return { vault: new MemoryAssetVault(), persistent: false };
  }
}

function realityAssetReference(value: unknown): Readonly<{ assetId: string; digest: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.assetId === "string" && typeof candidate.digest === "string"
    ? { assetId: candidate.assetId, digest: candidate.digest }
    : undefined;
}

const ProjectBar = lazy(() => import("./components/ProjectBar").then((module) => ({ default: module.ProjectBar })));
const Viewport = lazy(() => import("./components/Viewport").then((module) => ({ default: module.Viewport })));
const HybridWorkspaceCanvas = lazy(() => import("./components/workspace/HybridWorkspaceCanvas")
  .then((module) => ({ default: module.HybridWorkspaceCanvas })));
const WorkspaceChrome = lazy(() => import("./components/workspace/WorkspaceChrome")
  .then((module) => ({ default: module.WorkspaceChrome })));
const AgentWorkspaceControls = lazy(() => import("./components/AgentWorkspaceControls")
  .then((module) => ({ default: module.AgentWorkspaceControls })));
const AgentHistoryDrawer = lazy(() => import("./components/AgentWorkspaceControls")
  .then((module) => ({ default: module.AgentHistoryDrawer })));
const SceneBridgeDialog = lazy(() => import("./components/SceneBridgeDialog")
  .then((module) => ({ default: module.SceneBridgeDialog })));

function uid(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function publicVoiceRelayStatus(status: VoiceRelayStatus): Readonly<Record<string, unknown>> {
  return Object.freeze({
    enabled: status.enabled,
    armed: status.armed,
    phase: status.phase,
    ...(status.target ? {
      target: Object.freeze({
        label: status.target.label,
        capabilities: Object.freeze({ ...status.target.capabilities }),
      }),
    } : {}),
    ...(status.error ? { error: Object.freeze({ ...status.error }) } : {}),
  });
}

function recommendedVoiceRelayCandidate(
  candidates: readonly VoiceRelayTargetCandidate[],
  hints: readonly (string | undefined)[],
): VoiceRelayTargetCandidate | undefined {
  const compatible = candidates.filter((candidate) => candidate.compatible);
  const normalizedHints = hints.flatMap((hint) => hint?.trim().toLocaleLowerCase() || []);
  for (const hint of normalizedHints) {
    const matches = compatible.filter((candidate) =>
      candidate.label.toLocaleLowerCase().includes(hint)
      || candidate.applicationLabel.toLocaleLowerCase().includes(hint));
    if (matches.length === 1) return matches[0];
  }
  return compatible.length === 1 ? compatible[0] : undefined;
}

function xrHostPhase(
  sameDevice: XRWorkspaceButtonPhase,
  headset: XRHeadsetSessionPhase,
): XrHostPhase {
  if (sameDevice === "active") return "active";
  if (headset === "active") return "active";
  if (sameDevice === "requesting") return "entering";
  if (sameDevice === "ending") return "exiting";
  if (headset === "replica_ready") return "replica_ready";
  if (headset === "immersive_entering") return "immersive_entering";
  if (headset === "exiting") return "exiting";
  if (headset === "ended") return "ended";
  if (headset === "disconnected") return "disconnected";
  if (headset === "expired") return "expired";
  if (headset === "starting") return "preparing";
  if (headset === "pairing") return "pairing";
  if (sameDevice === "ready") return "ready";
  if (sameDevice === "error" || headset === "error") return "error";
  if (sameDevice === "unsupported" && headset === "idle") return "unavailable";
  return "idle";
}

function hostFeedAutomationDescriptor(
  resource: Readonly<WorkspaceResource>,
): HostFeedAutomationDescriptor | undefined {
  if (!isCanonicalHostFeedResource(resource)) return undefined;
  return {
    resourceId: resource.id,
    url: resource.config.url as string,
    format: resource.config.format as HostFeedFormat,
    policy: resource.policy,
  };
}

function stableAgentBrowserInstanceId(): string {
  try {
    const existing = globalThis.sessionStorage?.getItem(AGENT_BROWSER_INSTANCE_KEY);
    if (existing && /^[A-Za-z0-9._~-]{8,128}$/u.test(existing)) return existing;
    const created = uid("browser");
    globalThis.sessionStorage?.setItem(AGENT_BROWSER_INSTANCE_KEY, created);
    return created;
  } catch {
    return uid("browser");
  }
}

function initialProjectName(): string {
  const formatted = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date());
  return `Untitled world · ${formatted}`;
}

function downloadJson(name: string, contents: string): void {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "semaframe"}.semaframe.json`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadUsda(name: string, contents: string): void {
  downloadArtifact(name, "usda", [contents], "text/plain;charset=utf-8");
}

function downloadArtifact(
  name: string,
  extension: string,
  contents: readonly BlobPart[],
  type: string,
): void {
  const blob = new Blob([...contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.trim().replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-|-$/g, "") || "semaframe-model"}.${extension}`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function artifactStem(name: string, fallback = "semaframe"): string {
  return name.trim().replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-|-$/g, "") || fallback;
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

type BrowserSaveFilePicker = (options: Readonly<{
  suggestedName: string;
  types: readonly Readonly<{
    description: string;
    accept: Readonly<Record<string, readonly string[]>>;
  }>[];
}>) => Promise<Readonly<{
  createWritable(): Promise<Readonly<{
    write(value: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
  }>>;
}>>;

async function savePortableBundleToBrowser(
  name: string,
  bundle: Awaited<ReturnType<typeof createPortableProjectBundle>>,
): Promise<void> {
  const filename = `${artifactStem(name)}${PORTABLE_PROJECT_EXTENSION}`;
  const picker = (window as unknown as { showSaveFilePicker?: BrowserSaveFilePicker }).showSaveFilePicker;
  if (!picker) {
    if (bundle.byteLength > PORTABLE_PROJECT_LIMITS.defaultMaximumMaterializedBytes) {
      throw new Error(
        "This browser cannot stream a portable project of this size. Use a Chromium browser with the system save picker, or download the smaller metadata-only project instead.",
      );
    }
    downloadBlob(filename, await bundle.toBlob());
    return;
  }
  const handle = await picker({
    suggestedName: filename,
    types: [{
      description: "SemaFrame portable project",
      accept: { [PORTABLE_PROJECT_MEDIA_TYPE]: [PORTABLE_PROJECT_EXTENSION] },
    }],
  });
  const writable = await handle.createWritable();
  const reader = bundle.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
    }
    await writable.close();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function binaryBlobPart(contents: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(contents.byteLength);
  copy.set(contents);
  return copy.buffer;
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function sceneBridgeAlreadyRevoked(error: unknown): boolean {
  return error instanceof AgentGatewayError
    && (error.gatewayCode === "session_not_found" || error.gatewayCode === "session_expired");
}

function reconstructionPhotoMediaType(file: File): PhotoReconstructionMediaType | undefined {
  const declared = file.type.toLowerCase();
  if ((PHOTO_RECONSTRUCTION_MEDIA_TYPES as readonly string[]).includes(declared)) {
    return declared as PhotoReconstructionMediaType;
  }
  if (declared === "image/jpg") return "image/jpeg";
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return undefined;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Photo reconstruction cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Photo reconstruction cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function latestStatus(entries: WorkspaceHistoryEntry[]): WorkspaceHistoryStatus {
  return entries.at(-1)?.status ?? "ready";
}

function defaultWorkspacePlacement(
  manifest: ComponentManifest,
  ordinal: number,
  state?: Readonly<WorkspaceState>,
): ComponentPlacement {
  if (manifest.typeId === "stage-3d") {
    return {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }
  // Timers are deliberate HUD controls and video players are screen-fixed
  // media surfaces. Other 2D content belongs on the zoomable authored plane
  // by default so a dashboard does not fill every viewer's fixed viewport.
  const screenFixed = manifest.typeId === "timer" || manifest.typeId === "video-player";
  if (screenFixed && manifest.allowedPlacements.includes("viewport")) {
    const resizePolicy = resizePolicyForPlacement(manifest, "viewport");
    const size = resizePolicy.kind === "box2d"
      ? structuredClone(resizePolicy.defaultSize)
      : { width: 340, height: 220 };
    const base = {
      space: "viewport",
      anchor: manifest.typeId === "timer" ? "top_right" : "center",
      offset: { x: 0, y: 0 },
      size,
      zIndex: 20 + ordinal,
    } as const;
    return state
      ? findAvailableLayoutPlacement(state, { placement: base }) ?? base
      : base;
  }
  if (manifest.allowedPlacements.includes("canvas2d")) {
    const resizePolicy = resizePolicyForPlacement(manifest, "canvas2d");
    const base = {
      space: "canvas2d",
      position: { x: 0, y: 0 },
      size: resizePolicy.kind === "box2d"
        ? structuredClone(resizePolicy.defaultSize)
        : { width: 340, height: 220 },
      zIndex: ordinal,
    } as const;
    return state
      ? findAvailableLayoutPlacement(state, { placement: base }) ?? base
      : base;
  }
  if (manifest.allowedPlacements.includes("viewport")) {
    const resizePolicy = resizePolicyForPlacement(manifest, "viewport");
    const base = {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: resizePolicy.kind === "box2d"
        ? structuredClone(resizePolicy.defaultSize)
        : { width: 340, height: 220 },
      zIndex: 20 + ordinal,
    } as const;
    return state
      ? findAvailableLayoutPlacement(state, { placement: base }) ?? base
      : base;
  }
  return {
    space: "world3d",
    position: { x: (ordinal % 5) * 1.4 - 2.8, y: 0, z: Math.floor(ordinal / 5) * -1.5 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function agentConfigTrustIdentity(config: AgentGatewayConfig): string {
  return JSON.stringify({
    gatewayInstanceId: config.gatewayInstanceId,
    configRevision: config.configRevision,
    instructionVersion: config.instructionVersion,
    csrfToken: config.csrfToken,
    enabled: config.enabled,
    clientName: config.clientName ?? null,
    clientScopes: [...(config.clientScopes ?? [])].sort(),
    offerStatus: config.offerStatus ?? null,
    approvalFingerprint: config.pendingApproval?.fingerprint ?? null,
  });
}

function createAppRecoveryCoordinator(): WorkspaceRecoveryCoordinator | undefined {
  let localRepository: LocalStorageWorkspaceRecoveryRepository | undefined;
  try { localRepository = new LocalStorageWorkspaceRecoveryRepository(); } catch { /* storage may be blocked */ }
  let indexedRepository: IndexedDbWorkspaceRecoveryRepository | undefined;
  try {
    if (globalThis.indexedDB) indexedRepository = new IndexedDbWorkspaceRecoveryRepository();
  } catch { /* IndexedDB may be unavailable in a restricted browser */ }
  const repository = indexedRepository && localRepository
    ? new FallbackWorkspaceRecoveryRepository(indexedRepository, localRepository)
    : indexedRepository ?? localRepository;
  return repository ? new WorkspaceRecoveryCoordinator(repository) : undefined;
}

export default function App() {
  const workspaceStoreRef = useRef<WorkspaceStore | null>(null);
  if (!workspaceStoreRef.current) {
    workspaceStoreRef.current = new WorkspaceStore({
      registry: DEFAULT_COMPONENT_REGISTRY,
    });
  }
  const recoveryCoordinatorRef = useRef<WorkspaceRecoveryCoordinator | null | undefined>(null);
  if (recoveryCoordinatorRef.current === null) recoveryCoordinatorRef.current = createAppRecoveryCoordinator();
  const realityAssetVaultRef = useRef<AppRealityAssetVault | null>(null);
  if (!realityAssetVaultRef.current) realityAssetVaultRef.current = createAppRealityAssetVault();
  const hybridCanvasRef = useRef<HybridWorkspaceCanvasHandle>(null);
  const sameDeviceXrControlRef = useRef<XRWorkspaceButtonHandle>(null);
  const headsetXrControlRef = useRef<XRHeadsetSessionButtonHandle>(null);
  const sameDeviceXrStateRef = useRef<Readonly<{ phase: XRWorkspaceButtonPhase; message: string }>>({
    phase: "probing",
    message: "Checking this browser for WebXR…",
  });
  const headsetXrStateRef = useRef<Readonly<{ phase: XRHeadsetSessionPhase; message: string }>>({
    phase: "idle",
    message: "Headset projection is idle.",
  });
  const remoteXrContextRef = useRef<Readonly<{
    context: XRContextEnvelope;
    receivedAtMs: number;
    relayServerReceivedAtMs: number;
    relayQueueAgeMs: number;
  }> | undefined>(undefined);
  const preparedXrModeRef = useRef<"same_device" | "remote_headset" | undefined>(undefined);
  const xrAgentLifecycleCursorRef = useRef(0);
  const agentConnectionWasLiveRef = useRef(false);
  const agentTrustIdentityRef = useRef<string | undefined>(undefined);
  const hostActionLedgerRef = useRef(new HostActionLedger());
  const hostActionTrustEpochRef = useRef(0);
  const hostActionExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const confirmedHostActionOperationRef = useRef<Readonly<{
    trustEpoch: number;
    abort: AbortController;
    completion: Promise<unknown>;
  }> | undefined>(undefined);
  const voiceRelayTrustBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const hostActionExecutionRef = useRef<Readonly<{
    actionId: string;
    trustEpoch: number;
    confirm(): void | Promise<void>;
  }> | undefined>(undefined);
  const workspaceAgentControllerRef = useRef<WorkspaceAgentController | null>(null);
  const workspaceAgentRouterRef = useRef<WorkspaceAgentCommandRouter | null>(null);
  const completeRealityAssetImportRef = useRef<((candidateHandle: string) => Promise<JSONObject>) | null>(null);
  const realityAssetCompletionLedgerRef = useRef(
    new RealityAssetCompletionLedger<AppRealityAssetCompletion>(),
  );
  const agentGatewayRef = useRef<AgentGatewayClient | null>(null);
  const voiceRelayHostActionTokenRef = useRef<string | undefined>(undefined);
  const voiceRelayDisarmRef = useRef<Promise<void> | undefined>(undefined);
  const voiceRelayClientRef = useRef<VoiceRelayHttpClient | null>(null);
  if (!voiceRelayClientRef.current) {
    voiceRelayClientRef.current = new VoiceRelayHttpClient({
      baseUrl: VOICE_RELAY_HTTP_PATHS.desktopBase,
      requestHeaders: () => {
        const csrf = agentGatewayRef.current?.config?.csrfToken;
        const headers: Record<string, string> = {};
        if (csrf) headers["x-semaframe-agent-csrf"] = csrf;
        const hostActionToken = voiceRelayHostActionTokenRef.current;
        if (hostActionToken) headers[VOICE_RELAY_HOST_ACTION_HEADER] = hostActionToken;
        return headers;
      },
    });
  }
  const recoverySnapshotRef = useRef<() => void>(() => undefined);
  const allowAgentDestructiveRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const realityFileRef = useRef<HTMLInputElement>(null);
  const photoSetFileRef = useRef<HTMLInputElement>(null);
  const pendingRealityRelinkRef = useRef<string | null>(null);
  const realityImportAbortRef = useRef<AbortController | null>(null);
  const photoReconstructionAbortRef = useRef<AbortController | null>(null);
  const activePhotoReconstructionRef = useRef<TrackedPhotoReconstruction | null>(null);
  const photoReconstructionCancellationRef = useRef(
    new PhotoReconstructionCancellationTracker<PhotoReconstructionJobView>(),
  );
  const appMountedRef = useRef(false);
  const realityVaultLifecycleRef = useRef(0);
  const workspaceUnsubscribeRef = useRef<(() => void) | null>(null);
  const workspaceSerializerRef = useRef(new WorkspaceProjectSerializer(DEFAULT_COMPONENT_REGISTRY));
  const workspaceModelExportGateRef = useRef(new WorkspaceModelExportGate());
  const createdAtRef = useRef(new Date().toISOString());
  const agentBrowserInstanceIdRef = useRef(stableAgentBrowserInstanceId());
  const [workspace, setWorkspace] = useState<Readonly<WorkspaceState>>(workspaceStoreRef.current.getState());
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>(null);
  const [sceneBridgeOpen, setSceneBridgeOpen] = useState(false);
  const [sceneBridgeSession, setSceneBridgeSession] = useState<AgentBridgeSessionAccess>();
  const sceneBridgeSessionRef = useRef<AgentBridgeSessionAccess | undefined>(undefined);
  const sceneBridgeLifecycleRef = useRef(0);
  sceneBridgeSessionRef.current = sceneBridgeSession;
  const [sceneBridgePublication, setSceneBridgePublication] = useState<SceneBridgePublicationSummary>();
  const [sceneBridgeProposals, setSceneBridgeProposals] = useState<readonly AgentBridgeProposalRecord[]>([]);
  const [sceneBridgeBusy, setSceneBridgeBusy] = useState(false);
  const [sceneBridgeError, setSceneBridgeError] = useState<string>();
  const [startCenterDismissed, setStartCenterDismissed] = useState(false);
  const [workspaceConfigureRequestId, setWorkspaceConfigureRequestId] = useState<string>();
  const [entries, setEntriesState] = useState<WorkspaceHistoryEntry[]>([]);
  const entriesRef = useRef(entries);
  // Keep the visible activity list synchronous with Agent callbacks so
  // deduplicated transport retries cannot append duplicate UI entries.
  const setEntries = useCallback((action: SetStateAction<WorkspaceHistoryEntry[]>) => {
    const next = typeof action === "function"
      ? (action as (current: WorkspaceHistoryEntry[]) => WorkspaceHistoryEntry[])(entriesRef.current)
      : action;
    const bounded = next.slice(-MAX_VISIBLE_HISTORY_ENTRIES);
    entriesRef.current = bounded;
    setEntriesState(bounded);
  }, []);
  const [projectName, setProjectName] = useState(initialProjectName);
  const [projectId, setProjectId] = useState(() => uid("project"));
  const [dirty, setDirty] = useState(false);
  const [notices, setNotices] = useState<AppNotice[]>([]);
  const [confirm, setConfirm] = useState<"new" | "open" | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busyCount, setBusyCount] = useState(0);
  const busyRef = useRef(false);
  const recoveryStorageWarningRef = useRef(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(() => Boolean(safeStorageGet(RECOVERY_KEY)));
  const [agentSessionReady, setAgentSessionReady] = useState(false);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [agentManageOpen, setAgentManageOpen] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentGatewayStatus>("disabled");
  const [agentConfig, setAgentConfig] = useState<AgentGatewayConfig>();
  const [agentConfigPhase, setAgentConfigPhase] = useState<AgentConfigPhase>("loading");
  const [approvedAgentClaim, setApprovedAgentClaim] = useState<AgentConnectionClient>();
  const [agentError, setAgentError] = useState<string>();
  const [agentBrowserOccupied, setAgentBrowserOccupied] = useState(false);
  const agentBrowserOccupiedRef = useRef(agentBrowserOccupied);
  agentBrowserOccupiedRef.current = agentBrowserOccupied;
  const agentCommandGenerationRef = useRef(0);
  const [allowAgentDestructive, setAllowAgentDestructive] = useState(false);
  const [hostActionPrompt, setHostActionPrompt] = useState<HostActionPromptRequest>();
  const [voiceRelaySettingsOpen, setVoiceRelaySettingsOpen] = useState(false);
  const [voiceRelayStatus, setVoiceRelayStatus] = useState<VoiceRelayStatus>();
  const [voiceRelayPreparation, setVoiceRelayPreparation] = useState<VoiceRelaySetupPreparation>();
  const [voiceRelayDiagnostics, setVoiceRelayDiagnostics] = useState<VoiceRelayDiagnosticReport>();
  const [voiceRelaySettingsError, setVoiceRelaySettingsError] = useState<string>();
  const [realityAssetAvailability, setRealityAssetAvailability] = useState<Record<string, RealityAssetAvailability>>({});
  const [realityImportStatus, setRealityImportStatus] = useState<string>();
  const [realityImportBusy, setRealityImportBusy] = useState(false);
  const [photoReconstructionCapability, setPhotoReconstructionCapability] = useState<
    PhotoReconstructionCapability | "checking"
  >("checking");
  const [photoReconstructionProfile, setPhotoReconstructionProfile] = useState<PhotoReconstructionProfile>("balanced");
  const [photoReconstructionJob, setPhotoReconstructionJob] = useState<PhotoReconstructionJobView>();
  const [photoReconstructionStatus, setPhotoReconstructionStatus] = useState<string>();
  const [photoReconstructionBusy, setPhotoReconstructionBusy] = useState(false);
  const [realityMeasurement, setRealityMeasurement] = useState<RealityMeasurementEvent>();
  const [hostFeedRuntime, setHostFeedRuntime] = useState<Record<string, Readonly<{
    refreshing: boolean;
    error?: string;
    failureCount?: number;
    nextRetryAt?: number;
  }>>>({});
  const hostFeedRefreshInFlightRef = useRef(new Set<string>());
  const hostFeedRefreshControllersRef = useRef(new Map<string, AbortController>());
  const hostFeedPreviewControllersRef = useRef(new Set<AbortController>());
  const hostFeedOnOpenSeenRef = useRef(new Set<string>());
  const hostFeedAutomationConsentRef = useRef(new HostFeedAutomationConsentLedger());
  const [hostFeedAutomationRevision, setHostFeedAutomationRevision] = useState(0);
  const workspaceGenerationRef = useRef(0);
  const [workspaceRenderGeneration, setWorkspaceRenderGeneration] = useState(0);
  const [realityRenderGeneration, setRealityRenderGeneration] = useState(0);
  const busy = busyCount > 0;

  const invalidatePendingHostAction = useCallback((updateUi = true) => {
    hostActionTrustEpochRef.current += 1;
    if (hostActionExpiryTimerRef.current !== undefined) {
      clearTimeout(hostActionExpiryTimerRef.current);
      hostActionExpiryTimerRef.current = undefined;
    }
    voiceRelayHostActionTokenRef.current = undefined;
    const activeOperation = confirmedHostActionOperationRef.current;
    activeOperation?.abort.abort("host_action_trust_revoked");
    const priorBarrier = voiceRelayTrustBarrierRef.current.catch(() => undefined);
    const operationSettled = activeOperation?.completion.catch(() => undefined) ?? Promise.resolve();
    const revocationBarrier = Promise.all([priorBarrier, operationSettled]).then(async () => {
      await voiceRelayClientRef.current?.disarm();
    }).catch(() => undefined);
    voiceRelayTrustBarrierRef.current = revocationBarrier;
    hostActionLedgerRef.current.clear();
    hostActionExecutionRef.current = undefined;
    if (updateUi && appMountedRef.current) setHostActionPrompt(undefined);
  }, []);

  const confirmTrackedPhotoReconstructionCancellation = useCallback(async (
    active: TrackedPhotoReconstruction,
    updateUi = true,
    clientOverride?: AgentGatewayClient,
  ): Promise<PhotoReconstructionJobView> => {
    const client = clientOverride ?? agentGatewayRef.current;
    if (!client) throw new Error("The local photo reconstruction gateway is unavailable.");
    const job = await photoReconstructionCancellationRef.current.confirm(
      active,
      (tracked) => client.cancelPhotoReconstruction(tracked.jobId, tracked.workspaceId),
    );
    const current = activePhotoReconstructionRef.current;
    if (current?.jobId === active.jobId && current.workspaceId === active.workspaceId) {
      activePhotoReconstructionRef.current = null;
      if (updateUi && appMountedRef.current) {
        setPhotoReconstructionJob(job);
        setRealityImportBusy(false);
        setPhotoReconstructionBusy(false);
      }
    }
    return job;
  }, []);

  const advanceWorkspaceGeneration = useCallback(() => {
    invalidatePendingHostAction();
    remoteXrContextRef.current = undefined;
    preparedXrModeRef.current = undefined;
    void voiceRelayClientRef.current?.disarm().catch(() => undefined);
    hybridCanvasRef.current?.cancelRealityMeasurement();
    setRealityMeasurement(undefined);
    for (const controller of hostFeedRefreshControllersRef.current.values()) controller.abort();
    for (const controller of hostFeedPreviewControllersRef.current) controller.abort();
    hostFeedRefreshControllersRef.current.clear();
    hostFeedPreviewControllersRef.current.clear();
    hostFeedRefreshInFlightRef.current.clear();
    hostFeedOnOpenSeenRef.current.clear();
    hostFeedAutomationConsentRef.current.reset();
    realityAssetCompletionLedgerRef.current.clear();
    const activeReconstruction = activePhotoReconstructionRef.current;
    photoReconstructionAbortRef.current?.abort();
    photoReconstructionAbortRef.current = null;
    if (activeReconstruction) {
      setPhotoReconstructionStatus("Cancelling the previous photo reconstruction…");
      void confirmTrackedPhotoReconstructionCancellation(activeReconstruction).then(() => {
        if (appMountedRef.current) {
          setPhotoReconstructionStatus("Previous photo reconstruction cancelled and temporary inputs deleted.");
        }
      }).catch((error) => {
        if (appMountedRef.current) {
          setPhotoReconstructionStatus(
            `Warning: cancellation could not be confirmed; the previous job remains tracked. ${friendlyError(error)}`,
          );
        }
      });
    } else {
      setPhotoReconstructionJob(undefined);
      setPhotoReconstructionStatus(undefined);
      setPhotoReconstructionBusy(false);
    }
    setHostFeedRuntime({});
    setHostFeedAutomationRevision((current) => current + 1);
    workspaceGenerationRef.current += 1;
    setWorkspaceRenderGeneration(workspaceGenerationRef.current);
    setWorkspacePanel(null);
    setWorkspaceConfigureRequestId(undefined);
  }, [confirmTrackedPhotoReconstructionCancellation, invalidatePendingHostAction]);

  useEffect(() => {
    appMountedRef.current = true;
    const lifecycle = ++realityVaultLifecycleRef.current;
    return () => {
      appMountedRef.current = false;
      invalidatePendingHostAction(false);
      realityImportAbortRef.current?.abort();
      photoReconstructionAbortRef.current?.abort();
      photoReconstructionAbortRef.current = null;
      const activeReconstruction = activePhotoReconstructionRef.current;
      const cancellationClient = agentGatewayRef.current;
      // React StrictMode intentionally performs a setup/cleanup/setup cycle.
      // Delay disposal one microtask so the second setup can retain the vault,
      // while a real unmount still closes its database and Worker resources.
      queueMicrotask(() => {
        if (realityVaultLifecycleRef.current === lifecycle) {
          sceneBridgeLifecycleRef.current += 1;
          const bridgeSession = sceneBridgeSessionRef.current;
          if (bridgeSession) {
            agentGatewayRef.current?.releaseBridgeSession(bridgeSession.sessionId);
            sceneBridgeSessionRef.current = undefined;
          }
          preparedXrModeRef.current = undefined;
          void voiceRelayClientRef.current?.disarm().catch(() => undefined);
          if (activeReconstruction && cancellationClient) {
            void confirmTrackedPhotoReconstructionCancellation(
              activeReconstruction,
              false,
              cancellationClient,
            ).catch(() => undefined);
          }
          realityAssetVaultRef.current?.vault.dispose();
        }
      });
    };
  }, [confirmTrackedPhotoReconstructionCancellation, invalidatePendingHostAction]);

  useEffect(() => {
    const releaseSceneBridge = () => {
      sceneBridgeLifecycleRef.current += 1;
      const session = sceneBridgeSessionRef.current;
      if (!session) return;
      agentGatewayRef.current?.releaseBridgeSession(session.sessionId);
      sceneBridgeSessionRef.current = undefined;
    };
    window.addEventListener("pagehide", releaseSceneBridge);
    return () => window.removeEventListener("pagehide", releaseSceneBridge);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [dirty]);

  const notice = useCallback((message: string, tone: AppNotice["tone"] = "neutral") => {
    const item = { id: uid("notice"), message, tone };
    setNotices((current) => [...current, item].slice(-3));
    window.setTimeout(() => setNotices((current) => current.filter((entry) => entry.id !== item.id)), 4_500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initializeRecovery = async () => {
      const coordinator = recoveryCoordinatorRef.current;
      if (!coordinator) {
        if (!cancelled) setRecoveryAvailable(false);
        return;
      }
      try {
        const legacy = safeStorageGet(RECOVERY_KEY);
        if (legacy) {
          await coordinator.migrateLegacy(legacy, () => {
            if (!safeStorageRemove(RECOVERY_KEY)) throw new Error("Legacy recovery could not be cleared after migration");
          });
        }
        const available = Boolean(await coordinator.read());
        if (!cancelled) setRecoveryAvailable(available);
        // estimate() is passive: unlike persist(), it never asks the user for
        // storage permission. Two maximum-size snapshots are needed to keep a
        // real current/previous recovery pair.
        try {
          const estimate = await globalThis.navigator?.storage?.estimate?.();
          const remaining = estimate?.quota !== undefined && estimate.usage !== undefined
            ? estimate.quota - estimate.usage
            : undefined;
          if (!cancelled && remaining !== undefined && remaining < MAX_WORKSPACE_PROJECT_BYTES * 2) {
            notice("Browser storage is nearly full. Local recovery may not retain both current and previous snapshots; download a project copy.", "warning");
          }
        } catch { /* storage estimates are advisory and unavailable in some browsers */ }
      } catch (error) {
        if (!cancelled) {
          setRecoveryAvailable(Boolean(safeStorageGet(RECOVERY_KEY)));
          if (!recoveryStorageWarningRef.current) {
            recoveryStorageWarningRef.current = true;
            notice(`Local recovery could not be initialized: ${friendlyError(error)}`, "warning");
          }
        }
      }
    };
    void initializeRecovery();
    return () => { cancelled = true; };
  }, [notice]);

  const runConfirmedVoiceRelayHostAction = useCallback(async <T,>(
    action: "voice_relay_accessibility" | "voice_relay_configure_target" | "voice_relay_draft_round_trip" | "voice_relay_arm",
    operation: () => Promise<T>,
  ): Promise<T> => {
    const gateway = agentGatewayRef.current;
    if (!gateway) throw new Error("The local Agent gateway is unavailable.");
    if (confirmedHostActionOperationRef.current) {
      throw new Error("Another confirmed Voice Relay host action is still finishing.");
    }
    const trustEpoch = hostActionTrustEpochRef.current;
    const trustIdentity = agentTrustIdentityRef.current;
    const abort = new AbortController();
    const assertTrust = () => {
      if (abort.signal.aborted
        || trustEpoch !== hostActionTrustEpochRef.current
        || gateway !== agentGatewayRef.current
        || trustIdentity !== agentTrustIdentityRef.current) {
        throw new Error("The Agent trust context changed. Confirm the Voice Relay action again.");
      }
    };
    let grantToken: string | undefined;
    const completion = (async (): Promise<T> => {
      await voiceRelayTrustBarrierRef.current;
      assertTrust();
      const grant = await gateway.mintVoiceRelayHostAction(action);
      assertTrust();
      grantToken = grant.token;
      voiceRelayHostActionTokenRef.current = grant.token;
      assertTrust();
      const result = await operation();
      assertTrust();
      return result;
    })();
    confirmedHostActionOperationRef.current = Object.freeze({ trustEpoch, abort, completion });
    try {
      return await completion;
    } finally {
      if (grantToken && voiceRelayHostActionTokenRef.current === grantToken) {
        voiceRelayHostActionTokenRef.current = undefined;
      }
      if (confirmedHostActionOperationRef.current?.completion === completion) {
        confirmedHostActionOperationRef.current = undefined;
      }
    }
  }, []);

  const inspectVoiceRelaySettings = useCallback(async () => {
    setVoiceRelaySettingsError(undefined);
    try {
      setVoiceRelayStatus(await voiceRelayClientRef.current!.inspect());
    } catch (cause) {
      const message = friendlyError(cause);
      setVoiceRelaySettingsError(message);
      throw cause;
    }
  }, []);

  const prepareVoiceRelaySettings = useCallback(async () => {
    setVoiceRelaySettingsError(undefined);
    try {
      const preparation = await runConfirmedVoiceRelayHostAction(
        "voice_relay_accessibility",
        () => voiceRelayClientRef.current!.requestAccessibility(),
      );
      setVoiceRelayPreparation(preparation);
      setVoiceRelayStatus(await voiceRelayClientRef.current!.inspect());
      setVoiceRelayDiagnostics(undefined);
    } catch (cause) {
      setVoiceRelaySettingsError(friendlyError(cause));
      throw cause;
    }
  }, [runConfirmedVoiceRelayHostAction]);

  const configureVoiceRelayTarget = useCallback(async (candidateId: string) => {
    setVoiceRelaySettingsError(undefined);
    try {
      await runConfirmedVoiceRelayHostAction(
        "voice_relay_configure_target",
        () => voiceRelayClientRef.current!.configureTarget({ candidateId }),
      );
      setVoiceRelayStatus(await voiceRelayClientRef.current!.inspect());
      const preparation = await voiceRelayClientRef.current!.prepareSetup();
      setVoiceRelayPreparation(preparation);
      setVoiceRelayDiagnostics(undefined);
    } catch (cause) {
      setVoiceRelaySettingsError(friendlyError(cause));
      throw cause;
    }
  }, [runConfirmedVoiceRelayHostAction]);

  const diagnoseVoiceRelaySettings = useCallback(async () => {
    setVoiceRelaySettingsError(undefined);
    try {
      const report = await runConfirmedVoiceRelayHostAction(
        "voice_relay_draft_round_trip",
        () => voiceRelayClientRef.current!.runDiagnostics({ performDraftRoundTrip: true }),
      );
      setVoiceRelayDiagnostics(report);
      setVoiceRelayStatus(await voiceRelayClientRef.current!.inspect());
    } catch (cause) {
      setVoiceRelaySettingsError(friendlyError(cause));
      throw cause;
    }
  }, [runConfirmedVoiceRelayHostAction]);

  const armVoiceRelaySettings = useCallback(async (targetId?: string) => {
    setVoiceRelaySettingsError(undefined);
    try {
      const result = await runConfirmedVoiceRelayHostAction(
        "voice_relay_arm",
        () => voiceRelayClientRef.current!.requestArm(targetId),
      );
      setVoiceRelayStatus(result.status);
    } catch (cause) {
      setVoiceRelaySettingsError(friendlyError(cause));
      throw cause;
    }
  }, [runConfirmedVoiceRelayHostAction]);

  const disarmVoiceRelaySettings = useCallback(async () => {
    setVoiceRelaySettingsError(undefined);
    try {
      const result = await voiceRelayClientRef.current!.disarm();
      setVoiceRelayStatus(result.status);
    } catch (cause) {
      setVoiceRelaySettingsError(friendlyError(cause));
      throw cause;
    }
  }, []);

  const bestEffortDisarmVoiceRelay = useCallback((): Promise<void> => {
    voiceRelayHostActionTokenRef.current = undefined;
    const existing = voiceRelayDisarmRef.current;
    if (existing) return existing;
    const client = voiceRelayClientRef.current;
    if (!client) return Promise.resolve();
    const pending = client.disarm().then((result) => {
      if (appMountedRef.current) setVoiceRelayStatus(result.status);
    }).catch(() => undefined).finally(() => {
      if (voiceRelayDisarmRef.current === pending) voiceRelayDisarmRef.current = undefined;
    });
    voiceRelayDisarmRef.current = pending;
    return pending;
  }, []);

  const presentHostAction = useCallback((input: Readonly<{
    kind: Parameters<HostActionLedger["request"]>[0]["kind"];
    label: string;
    dedupeKey: string;
    title: string;
    message: string;
    targetLabel?: string;
    confirmLabel: string;
    confirm(): void | Promise<void>;
  }>): RequiredUserAction => {
    const action = hostActionLedgerRef.current.request({
      kind: input.kind,
      label: input.label,
      dedupeKey: input.dedupeKey,
      trustEpoch: hostActionTrustEpochRef.current,
    });
    if (hostActionExecutionRef.current?.actionId !== action.action_id) {
      const trustEpoch = hostActionTrustEpochRef.current;
      hostActionExecutionRef.current = Object.freeze({
        actionId: action.action_id,
        trustEpoch,
        confirm: input.confirm,
      });
      if (hostActionExpiryTimerRef.current !== undefined) {
        clearTimeout(hostActionExpiryTimerRef.current);
      }
      const expiryDelayMs = Math.max(
        0,
        (action.expires_at ? new Date(action.expires_at).getTime() : Date.now() + 60_000) - Date.now(),
      );
      hostActionExpiryTimerRef.current = setTimeout(() => {
        const execution = hostActionExecutionRef.current;
        if (execution?.actionId !== action.action_id || execution.trustEpoch !== trustEpoch) return;
        hostActionLedgerRef.current.clear();
        hostActionExecutionRef.current = undefined;
        hostActionExpiryTimerRef.current = undefined;
        if (appMountedRef.current) setHostActionPrompt(undefined);
      }, expiryDelayMs);
      setHostActionPrompt({
        id: action.action_id,
        kind: action.kind,
        title: input.title,
        message: input.message,
        ...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
        confirmLabel: input.confirmLabel,
      });
    }
    return action;
  }, []);

  const confirmHostAction = useCallback(() => {
    const execution = hostActionExecutionRef.current;
    if (!execution) return;
    if (execution.trustEpoch !== hostActionTrustEpochRef.current) {
      invalidatePendingHostAction();
      notice("This Agent request belongs to an expired trust context. Ask the Agent to request it again.", "warning");
      return;
    }
    // Invoke synchronously inside the trusted click. WebXR's transient user
    // activation would be lost if this were deferred behind an await/timer.
    let outcome: void | Promise<void>;
    try {
      hostActionLedgerRef.current.decide(execution.actionId, "confirmed", execution.trustEpoch);
      if (hostActionExpiryTimerRef.current !== undefined) {
        clearTimeout(hostActionExpiryTimerRef.current);
        hostActionExpiryTimerRef.current = undefined;
      }
      outcome = execution.confirm();
      setHostActionPrompt((current) => current?.id === execution.actionId
        ? { ...current, busy: true }
        : current);
    } catch (cause) {
      hostActionExecutionRef.current = undefined;
      setHostActionPrompt(undefined);
      notice(cause instanceof Error ? cause.message : "The requested host action could not start.", "warning");
      return;
    }
    void Promise.resolve(outcome).then(() => {
      notice("The requested host action completed.", "success");
    }).catch((cause) => {
      notice(cause instanceof Error ? cause.message : "The requested host action failed.", "warning");
    }).finally(() => {
      if (hostActionExecutionRef.current?.actionId === execution.actionId) {
        hostActionExecutionRef.current = undefined;
        setHostActionPrompt(undefined);
      }
    });
  }, [invalidatePendingHostAction, notice]);

  const cancelHostAction = useCallback(() => {
    const execution = hostActionExecutionRef.current;
    if (!execution) return;
    try {
      hostActionLedgerRef.current.decide(execution.actionId, "declined", execution.trustEpoch);
    } catch (cause) {
      if (!(cause instanceof HostActionLedgerError) || cause.code !== "host_action_not_found") throw cause;
    }
    if (hostActionExpiryTimerRef.current !== undefined) {
      clearTimeout(hostActionExpiryTimerRef.current);
      hostActionExpiryTimerRef.current = undefined;
    }
    hostActionExecutionRef.current = undefined;
    setHostActionPrompt(undefined);
    notice("The Agent-requested host action was declined.", "neutral");
  }, [notice]);

  const handleRealityMeasurement = useCallback((event: RealityMeasurementEvent) => {
    setRealityMeasurement((current) => {
      if (event.kind === "cancelled") {
        return current?.componentId === event.componentId
          && current.assetId === event.assetId
          && current.assetDigest === event.assetDigest
          && current.sessionId === event.sessionId
          ? undefined
          : current;
      }
      return event;
    });
  }, []);

  const startRealityMeasurement = useCallback((componentId: string): boolean => {
    const started = hybridCanvasRef.current?.startRealityMeasurement(componentId) ?? false;
    if (!started) {
      notice("The Gaussian surface is not ready for picking. Wait for it to render or relink the local capture bytes.", "warning");
    }
    return started;
  }, [notice]);

  const cancelRealityMeasurement = useCallback(() => {
    hybridCanvasRef.current?.cancelRealityMeasurement();
    setRealityMeasurement(undefined);
  }, []);

  useEffect(() => {
    // Import/relink replaces the canvas key and therefore its ephemeral Three
    // measurement helpers. Never leave an Inspector draft claiming that a
    // session survived that renderer lifetime boundary.
    cancelRealityMeasurement();
  }, [cancelRealityMeasurement, realityRenderGeneration]);

  useEffect(() => {
    if (realityMeasurement && realityMeasurement.componentId !== selectedComponentId) {
      cancelRealityMeasurement();
    }
  }, [cancelRealityMeasurement, realityMeasurement, selectedComponentId]);

  const realityAssetDescriptorSignature = useMemo(() => JSON.stringify(
    [...workspace.realityAssets.values()]
      .map((descriptor) => [descriptor.assetId, descriptor.digest, descriptor.byteLength])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  ), [workspace.realityAssets]);

  useEffect(() => {
    let cancelled = false;
    const descriptors = [...workspace.realityAssets.values()];
    setRealityAssetAvailability(Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.assetId,
      "checking" satisfies RealityAssetAvailability,
    ])));
    void Promise.all(descriptors.map(async (descriptor) => {
      let availability: RealityAssetAvailability;
      try {
        const blob = await realityAssetVaultRef.current!.vault.open(descriptor.assetId);
        availability = blob.size === descriptor.byteLength ? "available" : "error";
      } catch (error) {
        availability = error instanceof RealityAssetError && error.code === "not_found"
          ? "missing"
          : "error";
      }
      if (!cancelled) {
        setRealityAssetAvailability((current) => ({ ...current, [descriptor.assetId]: availability }));
      }
    }));
    return () => { cancelled = true; };
  }, [realityAssetDescriptorSignature, realityRenderGeneration, workspaceRenderGeneration]);

  const openRealityAsset = useCallback(async (
    assetId: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<Blob | undefined> => {
    if (signal?.aborted) throw new DOMException("Reality asset read cancelled", "AbortError");
    const descriptor = workspaceStoreRef.current?.getState().realityAssets.get(assetId);
    if (!descriptor || descriptor.digest !== digest) return undefined;
    const blob = await realityAssetVaultRef.current!.vault.open(descriptor.assetId);
    if (signal?.aborted) throw new DOMException("Reality asset read cancelled", "AbortError");
    if (blob.size !== descriptor.byteLength) throw new Error("Reality asset bytes do not match the registered descriptor.");
    return blob;
  }, []);

  const runExclusive = useCallback(async <T,>(operation: () => T | Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusyCount(1);
    try {
      return await operation();
    } finally {
      busyRef.current = false;
      setBusyCount(0);
    }
  }, []);

  const runAgentAction = useCallback(async <T,>(operation: () => T | Promise<T>): Promise<T> => {
    if (busyRef.current) throw new Error("Another Workspace operation is still in progress.");
    return await runExclusive(operation) as T;
  }, [runExclusive]);

  const connectWorkspaceStore = useCallback((store: WorkspaceStore) => {
    workspaceUnsubscribeRef.current?.();
    advanceWorkspaceGeneration();
    setSelectedComponentId(null);
    const initialState = store.getState();
    hostFeedAutomationConsentRef.current.reconcile(
      [...initialState.resources.values()].flatMap((resource) => {
        const descriptor = hostFeedAutomationDescriptor(resource);
        return descriptor ? [descriptor] : [];
      }),
    );
    setWorkspace(initialState);
    workspaceUnsubscribeRef.current = store.subscribe((state) => {
      if (hostFeedAutomationConsentRef.current.reconcile(
        [...state.resources.values()].flatMap((resource) => {
          const descriptor = hostFeedAutomationDescriptor(resource);
          return descriptor ? [descriptor] : [];
        }),
      )) {
        setHostFeedAutomationRevision((current) => current + 1);
      }
      setWorkspace(state);
      setSelectedComponentId((current) => current && state.components.has(current) ? current : null);
    });
  }, [advanceWorkspaceGeneration]);

  const installWorkspaceAgentController = useCallback((store: WorkspaceStore) => {
    workspaceAgentControllerRef.current?.revokeAll();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    const controller = new WorkspaceAgentController(adapter, {
      grantScopes: ({ requestedScopes }) => requestedScopes.filter((scope) => {
        if (scope === "effect:external_write" || scope === "extension:install") return false;
        if (!allowAgentDestructiveRef.current && [
          "component:delete",
          "connector:delete",
          "workspace:clear",
        ].includes(scope)) return false;
        return true;
      }) as WorkspacePermissionScope[],
      completeRealityAssetImport: async (candidateHandle) => {
        const complete = completeRealityAssetImportRef.current;
        if (!complete) throw new Error("The browser Reality Asset importer is not ready.");
        return complete(candidateHandle);
      },
    });
    workspaceAgentControllerRef.current = controller;
    workspaceAgentRouterRef.current = new WorkspaceAgentCommandRouter(controller);
  }, []);

  const revokeAgentContexts = useCallback((_reason: string) => {
    invalidatePendingHostAction();
    workspaceAgentControllerRef.current?.revokeAll();
  }, [invalidatePendingHostAction]);

  const stopXrForProjectReplacement = useCallback(async () => {
    const failures = await stopXrSessionsForProjectReplacement(
      sameDeviceXrControlRef.current,
      headsetXrControlRef.current,
    );
    remoteXrContextRef.current = undefined;
    preparedXrModeRef.current = undefined;
    if (failures.length > 0) {
      notice("XR teardown could not be fully confirmed; check the headset or browser session.", "warning");
    }
  }, [notice]);

  const stopAgentForProjectChange = useCallback(async (reason: string) => {
    voiceRelayHostActionTokenRef.current = undefined;
    remoteXrContextRef.current = undefined;
    preparedXrModeRef.current = undefined;
    const client = agentGatewayRef.current;
    const occupied = agentBrowserOccupiedRef.current;
    agentCommandGenerationRef.current += 1;
    const quiescence = quiesceAgentBridgeForProjectReplacement({
      client: client ?? undefined,
      occupied,
      revoke: () => revokeAgentContexts(reason),
      waitForTrustRevocation: () => voiceRelayTrustBarrierRef.current,
    });
    // Close the trusted desktop surface in the same turn that aborts the old
    // command loop. The store is replaced only after that loop has settled.
    allowAgentDestructiveRef.current = false;
    setAllowAgentDestructive(false);
    setAgentEnabled(false);
    setAgentStatus("disabled");
    setAgentConfig(undefined);
    setApprovedAgentClaim(undefined);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    setAgentBrowserOccupied(false);
    await quiescence;
    await Promise.all([
      stopXrForProjectReplacement(),
      bestEffortDisarmVoiceRelay(),
    ]);
    // A best-effort disable refresh may have published one final config while
    // draining. Keep the replacement boundary visibly and logically closed.
    setAgentEnabled(false);
    setAgentStatus("disabled");
    setAgentConfig(undefined);
    setApprovedAgentClaim(undefined);
    setAgentSessionReady(false);
  }, [bestEffortDisarmVoiceRelay, revokeAgentContexts, stopXrForProjectReplacement]);

  useEffect(() => {
    installWorkspaceAgentController(workspaceStoreRef.current!);
    connectWorkspaceStore(workspaceStoreRef.current!);
    return () => {
      workspaceUnsubscribeRef.current?.();
      workspaceUnsubscribeRef.current = null;
      workspaceAgentControllerRef.current?.revokeAll();
      for (const controller of hostFeedRefreshControllersRef.current.values()) controller.abort();
      for (const controller of hostFeedPreviewControllersRef.current) controller.abort();
      hostFeedRefreshControllersRef.current.clear();
      hostFeedPreviewControllersRef.current.clear();
      hostFeedRefreshInFlightRef.current.clear();
    };
  }, [connectWorkspaceStore, installWorkspaceAgentController]);

  const storeRecoveryProject = useCallback(async (
    recoveryProjectName: string,
    project: WorkspaceProjectFile,
  ): Promise<void> => {
    const coordinator = recoveryCoordinatorRef.current;
    if (!coordinator) throw new Error("browser recovery storage is unavailable");
    await coordinator.schedule({
      projectName: recoveryProjectName,
      serializedProject: workspaceSerializerRef.current.serialize(project),
      projectId: project.projectId,
      workspaceRevision: project.workspace.revision,
      // This is the recovery capture time, not the source project's authored
      // timestamp. It lets the fallback repository order snapshots correctly
      // even when opening an older project file after an IndexedDB failure.
      createdAt: new Date().toISOString(),
    });
  }, []);

  const recoverySnapshot = useCallback(() => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) return;
      const project = workspaceSerializerRef.current.fromStore(
        projectId,
        store,
        { createdAt: createdAtRef.current },
      );
      void storeRecoveryProject(projectName, project).then(() => {
        recoveryStorageWarningRef.current = false;
        if (appMountedRef.current) setRecoveryAvailable(true);
      }).catch((error) => {
        if (!recoveryStorageWarningRef.current && appMountedRef.current) {
          recoveryStorageWarningRef.current = true;
          notice(`Local recovery is unavailable: ${friendlyError(error)} Download a copy to protect your work.`, "warning");
        }
      });
    } catch (error) {
      if (!recoveryStorageWarningRef.current) {
        recoveryStorageWarningRef.current = true;
        notice(`Local recovery is unavailable: ${friendlyError(error)}`, "warning");
      }
    }
  }, [notice, projectId, projectName, storeRecoveryProject]);
  recoverySnapshotRef.current = recoverySnapshot;

  const closeSceneBridgeForProjectChange = useCallback(async () => {
    const session = sceneBridgeSession;
    if (!session) return;
    if (sceneBridgeBusy) throw new Error("Wait for the active Scene Bridge operation to finish.");
    const client = agentGatewayRef.current;
    if (!client) throw new Error("The local gateway is unavailable, so the old Scene Bridge cannot be revoked safely.");
    try {
      await client.closeBridgeSession(session.sessionId);
    } catch (error) {
      if (!sceneBridgeAlreadyRevoked(error)) throw error;
    }
    sceneBridgeLifecycleRef.current += 1;
    sceneBridgeSessionRef.current = undefined;
    setSceneBridgeSession(undefined);
    setSceneBridgePublication(undefined);
    setSceneBridgeProposals([]);
    setSceneBridgeError(undefined);
    setSceneBridgeOpen(false);
  }, [sceneBridgeBusy, sceneBridgeSession]);

  const save = useCallback(() => {
    if (busyRef.current) return;
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The workspace is not ready.");
      const project = workspaceSerializerRef.current.fromStore(
        projectId,
        store,
        { createdAt: createdAtRef.current },
      );
      downloadJson(projectName, workspaceSerializerRef.current.serialize(project));
      setDirty(false);
      notice(store.getState().realityAssets.size > 0
        ? "Workspace saved with Reality references; private Reality bytes remain in this browser's local vault."
        : "Workspace saved with its components, data, connections, and resolved history.", "success");
    } catch (error) { notice(`Couldn’t save: ${friendlyError(error)}`, "error"); }
  }, [notice, projectId, projectName]);

  const savePortableProject = useCallback(async () => {
    await runExclusive(async () => {
      try {
        const store = workspaceStoreRef.current;
        if (!store) throw new Error("The workspace is not ready.");
        const project = workspaceSerializerRef.current.fromStore(
          projectId,
          store,
          { createdAt: createdAtRef.current },
        );
        const bundle = await createPortableProjectBundle(
          project,
          realityAssetVaultRef.current!.vault,
          { serializer: workspaceSerializerRef.current },
        );
        await savePortableBundleToBrowser(projectName, bundle);
        setDirty(false);
        notice(
          `Portable project saved with ${bundle.manifest.assets.length} verified Reality asset${bundle.manifest.assets.length === 1 ? "" : "s"}.`,
          "success",
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        notice(`Couldn’t save portable project: ${friendlyError(error)}`, "error");
      }
    });
  }, [notice, projectId, projectName, runExclusive]);

  const exportSceneExchange = useCallback(async () => {
    await runExclusive(async () => {
      try {
        const state = workspaceStoreRef.current?.getState();
        if (!state) throw new Error("The workspace is not ready.");
        const exchange = await createSemaFrameExchange(state, {
          registry: DEFAULT_COMPONENT_REGISTRY,
        });
        downloadBlob(
          `${artifactStem(projectName)}.semaframe-exchange`,
          new Blob([binaryBlobPart(exchange.archive.bytes)], { type: exchange.archive.mediaType }),
        );
        notice(
          `Scene Exchange exported ${exchange.manifest.nodes.length} stable component${exchange.manifest.nodes.length === 1 ? "" : "s"} with OpenUSD, GLB, semantics, and a fidelity report.`,
          "success",
        );
      } catch (error) {
        notice(`Couldn’t export Scene Exchange: ${friendlyError(error)}`, "error");
      }
    });
  }, [notice, projectName, runExclusive]);

  const loadProject = useCallback(async (file: File) => {
    await runExclusive(async () => {
      try {
        const restoredName = file.name.replace(/\.semaframe-project$|\.semaframe\.json$|\.json$/i, "");
        const result = await importWorkspaceProjectArtifact(file, {
          vault: realityAssetVaultRef.current!.vault,
          serializer: workspaceSerializerRef.current,
          commitProject: async (project) => {
            const nextWorkspaceStore = workspaceSerializerRef.current.openStore(project);
            await closeSceneBridgeForProjectChange();
            await stopAgentForProjectChange("project_opened");
            await recoveryCoordinatorRef.current?.replaceGeneration({ clear: false });

            workspaceStoreRef.current = nextWorkspaceStore;
            installWorkspaceAgentController(nextWorkspaceStore);
            connectWorkspaceStore(nextWorkspaceStore);
            setProjectId(project.projectId);
            createdAtRef.current = project.createdAt;
            setProjectName(restoredName);
            setStartCenterDismissed(true);
            setEntries(historyEntriesForStore(nextWorkspaceStore));
            setDirty(false);
            setRecoveryAvailable(false);
          },
        });

        try {
          await storeRecoveryProject(restoredName, result.project);
          recoveryStorageWarningRef.current = false;
          notice(result.kind === "portable"
            ? `Portable Workspace opened with ${result.importedAssetIds.length} imported and ${result.reusedAssetIds.length} reused Reality asset${result.importedAssetIds.length + result.reusedAssetIds.length === 1 ? "" : "s"}.`
            : "Workspace opened from its validated resolved history.", "success");
        } catch (error) {
          recoveryStorageWarningRef.current = true;
          notice(`Workspace opened, but local recovery could not be stored. Download a copy to protect it. ${friendlyError(error)}`, "warning");
        }
      } catch (error) {
        notice(`This Workspace project could not be opened. Your current project is unchanged. ${friendlyError(error)}`, "error");
      }
    });
  }, [closeSceneBridgeForProjectChange, connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange, storeRecoveryProject]);

  const resetProject = useCallback(async () => {
    await runExclusive(async () => {
      await closeSceneBridgeForProjectChange();
      await stopAgentForProjectChange("new_project");
      const nextWorkspaceStore = new WorkspaceStore({
        registry: DEFAULT_COMPONENT_REGISTRY,
      });
      workspaceStoreRef.current = nextWorkspaceStore;
      installWorkspaceAgentController(nextWorkspaceStore);
      connectWorkspaceStore(nextWorkspaceStore);
      setEntries([]);
      setProjectId(uid("project"));
      setProjectName(initialProjectName());
      setStartCenterDismissed(false);
      setDirty(false);
      createdAtRef.current = new Date().toISOString();
      try {
        await recoveryCoordinatorRef.current?.clear();
        const legacyRecoveryPresent = safeStorageGet(RECOVERY_KEY) !== null;
        if (!safeStorageRemove(RECOVERY_KEY) && legacyRecoveryPresent) {
          throw new Error("Legacy browser recovery storage could not be cleared.");
        }
      } catch (error) {
        notice(`New Workspace created, but browser recovery storage could not be cleared. ${friendlyError(error)}`, "warning");
        setRecoveryAvailable(true);
        return;
      }
      setRecoveryAvailable(false);
    });
  }, [closeSceneBridgeForProjectChange, connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange]);

  const restoreRecovery = useCallback(async () => {
    await runExclusive(async () => {
      const coordinator = recoveryCoordinatorRef.current;
      const candidates = coordinator ? await coordinator.readCandidates().catch(() => []) : [];
      if (candidates.length > 0) {
        try {
          await closeSceneBridgeForProjectChange();
        } catch (error) {
          notice(`Recovery was not opened because the current Scene Bridge could not be closed safely. ${friendlyError(error)}`, "error");
          return;
        }
      }
      let lastError: unknown = new Error("Recovery snapshot is unavailable.");
      for (const recovered of candidates) {
        try {
          const project = workspaceSerializerRef.current.deserialize(recovered.snapshot.serializedProject);
          await verifyWorkspaceProjectCadEvidence(project);
          const nextWorkspaceStore = workspaceSerializerRef.current.openStore(project);
          await stopAgentForProjectChange("recovery_restored");
          await coordinator?.replaceGeneration({ clear: false });
          workspaceStoreRef.current = nextWorkspaceStore;
          installWorkspaceAgentController(nextWorkspaceStore);
          connectWorkspaceStore(nextWorkspaceStore);
          setProjectId(project.projectId);
          setProjectName(recovered.snapshot.projectName || "Recovered world");
          setStartCenterDismissed(true);
          createdAtRef.current = project.createdAt;
          setEntries(historyEntriesForStore(nextWorkspaceStore));
          setDirty(true);
          setRecoveryAvailable(false);
          notice(recovered.recoveredFromPrevious
            ? "Recovered the last-known-good Workspace snapshot because the current recovery was invalid or older."
            : "Recovered your last local Workspace snapshot.", "success");
          return;
        } catch (error) {
          lastError = error;
        }
      }
      try {
        await coordinator?.clear();
        const legacyRecoveryPresent = safeStorageGet(RECOVERY_KEY) !== null;
        if (!safeStorageRemove(RECOVERY_KEY) && legacyRecoveryPresent) {
          throw new Error("Legacy browser recovery storage could not be cleared.");
        }
        setRecoveryAvailable(false);
        notice(`Recovery could not be opened: ${friendlyError(lastError)}`, "error");
      } catch (clearError) {
        setRecoveryAvailable(true);
        notice(
          `Recovery could not be opened or cleared. ${friendlyError(lastError)} ${friendlyError(clearError)}`,
          "error",
        );
      }
    });
  }, [closeSceneBridgeForProjectChange, connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange]);

  const dismissRecovery = useCallback(async () => {
    try {
      await recoveryCoordinatorRef.current?.clear();
      const legacyRecoveryPresent = safeStorageGet(RECOVERY_KEY) !== null;
      if (!safeStorageRemove(RECOVERY_KEY) && legacyRecoveryPresent) {
        throw new Error("Legacy browser recovery storage could not be cleared.");
      }
    } catch (error) {
      notice(`Recovery could not be dismissed: ${friendlyError(error)}`, "warning");
      return;
    }
    setRecoveryAvailable(false);
  }, [notice]);

  const undo = useCallback(() => {
    if (busyRef.current) return;
    revokeAgentContexts("human_undo");
    const delta = workspaceStoreRef.current?.undoUserCommand() ?? null;
    if (!delta) return;
    setEntries((current) => {
      const next = current.map((entry) => ({ ...entry }));
      const target = [...next].reverse().find((entry) =>
        ["committed", "approximated", "idempotent"].includes(entry.status));
      if (target) target.status = "undone";
      return next;
    });
    setDirty(true);
    window.setTimeout(recoverySnapshot, 0);
  }, [recoverySnapshot, revokeAgentContexts]);
  const redo = useCallback(() => {
    if (busyRef.current) return;
    revokeAgentContexts("human_redo");
    const delta = workspaceStoreRef.current?.redoUserCommand() ?? null;
    if (!delta) return;
    setEntries((current) => {
      const next = current.map((entry) => ({ ...entry }));
      const target = next.find((entry) => entry.status === "undone");
      if (target) target.status = "committed";
      return next;
    });
    setDirty(true);
    window.setTimeout(recoverySnapshot, 0);
  }, [recoverySnapshot, revokeAgentContexts]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (sceneBridgeOpen) {
        if (command && ["s", "o", "z", "y"].includes(event.key.toLowerCase())) {
          event.preventDefault();
        }
        return;
      }
      const editableTarget = event.target instanceof HTMLElement && (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target.isContentEditable
      );
      if (command && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
      if (command && event.key.toLowerCase() === "o") { event.preventDefault(); if (!busy) fileRef.current?.click(); }
      if (command && !editableTarget && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); if (!busy) undo(); }
      if (command && !editableTarget && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) { event.preventDefault(); if (!busy) redo(); }
      if (event.key === "Escape") { setConfirm(null); setPendingFile(null); setAgentManageOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, redo, save, sceneBridgeOpen, undo]);

  const applyWorkspaceOperations = useCallback((
    operations: WorkspaceOperation[],
    summary: string,
    expectedRevision?: number,
  ) => {
    const store = workspaceStoreRef.current;
    if (!store) throw new Error("The component workspace is not ready.");
    const state = store.getState();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new Error(`The workspace changed while you were editing it (expected revision ${expectedRevision}, current ${state.revision}).`);
    }
    const batch: WorkspaceCommandBatch = {
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: uid("workspace_request"),
      workspace_id: state.workspaceId,
      input_revision: state.revision + 1,
      base_workspace_revision: state.revision,
      registry_digest: state.registryDigest,
      mode: "commit",
      operations,
    };
    const result = store.applyDetailed(batch);
    setEntries((current) => {
      const entry: WorkspaceHistoryEntry = {
        id: result.command.requestId,
        inputRevision: result.state.revision,
        text: summary,
        status: result.deduplicated ? "idempotent" : "committed",
        source: "manual",
        summary,
        traceId: result.command.requestId,
      };
      return current.some((candidate) => candidate.id === entry.id) ? current : [...current, entry];
    });
    setDirty(true);
    notice(`${summary} · workspace revision ${result.state.revision}`, "success");
    window.setTimeout(() => recoverySnapshotRef.current(), 0);
    return result;
  }, [notice]);

  const publishSceneBridgeSnapshot = useCallback(async (
    session: AgentBridgeSessionAccess,
    sequence: number,
  ): Promise<SceneBridgePublicationSummary> => {
    const client = agentGatewayRef.current;
    const store = workspaceStoreRef.current;
    if (!client || !store) throw new Error("The local Scene Bridge is unavailable.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    if (!sessionIsCurrent()) throw new Error("The Scene Bridge session is no longer active.");
    const source = store.getState();
    const exchange = await createSemaFrameExchange(source, { registry: DEFAULT_COMPONENT_REGISTRY });
    if (store.getState().revision !== source.revision || store.getState().workspaceId !== source.workspaceId) {
      throw new Error("The Workspace changed while Scene Exchange was being built. Publish again.");
    }
    if (!sessionIsCurrent()) throw new Error("The Scene Bridge session ended while the exchange was being built.");
    await client.publishBridgeSession(session.sessionId, sequence, exchange);
    if (!sessionIsCurrent()) throw new Error("The Scene Bridge session ended while the exchange was being published.");
    const summary = Object.freeze({
      sequence,
      revision: exchange.manifest.source.revision,
      digest: exchange.archive.sha256,
    });
    setSceneBridgePublication(summary);
    return summary;
  }, []);

  const createSceneBridgeSession = useCallback(async (target: SemaFrameBridgeTarget) => {
    if (busyRef.current || sceneBridgeBusy) throw new Error("Another Workspace operation is still in progress.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      await runExclusive(async () => {
        if (sceneBridgeSession) throw new Error("Close the current Scene Bridge before creating another one.");
        const client = agentGatewayRef.current;
        const store = workspaceStoreRef.current;
        if (!client || !store) throw new Error("The local Scene Bridge is unavailable.");
        const source = store.getState();
        const exchange = await createSemaFrameExchange(source, { registry: DEFAULT_COMPONENT_REGISTRY });
        if (store.getState().revision !== source.revision || store.getState().workspaceId !== source.workspaceId) {
          throw new Error("The Workspace changed while Scene Exchange was being built. Try again.");
        }
        const access = await client.createBridgeSession(target, exchange);
        if (sceneBridgeLifecycleRef.current !== lifecycle) {
          client.releaseBridgeSession(access.sessionId);
          throw new Error("The Agent connection changed while Scene Bridge was being created.");
        }
        sceneBridgeSessionRef.current = access;
        setSceneBridgeSession(access);
        setSceneBridgePublication(Object.freeze({
          sequence: 1,
          revision: exchange.manifest.source.revision,
          digest: exchange.archive.sha256,
        }));
        setSceneBridgeProposals([]);
        notice(`${target === "freecad" ? "FreeCAD" : target === "unreal" ? "Unreal Engine" : target[0].toUpperCase() + target.slice(1)} Scene Bridge created. Copy its scoped setup JSON into the adapter.`, "success");
      });
    } catch (error) {
      if (sceneBridgeLifecycleRef.current === lifecycle) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (sceneBridgeLifecycleRef.current === lifecycle) setSceneBridgeBusy(false);
    }
  }, [notice, runExclusive, sceneBridgeBusy, sceneBridgeSession]);

  const publishLatestSceneBridge = useCallback(async () => {
    if (busyRef.current || sceneBridgeBusy) throw new Error("Another Workspace operation is still in progress.");
    const session = sceneBridgeSession;
    const publication = sceneBridgePublication;
    if (!session || !publication) throw new Error("Create a Scene Bridge first.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      await runExclusive(async () => {
        const next = await publishSceneBridgeSnapshot(session, publication.sequence + 1);
        notice(`Scene Bridge published Workspace revision ${next.revision}.`, "success");
      });
    } catch (error) {
      if (sessionIsCurrent()) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (sessionIsCurrent()) setSceneBridgeBusy(false);
    }
  }, [notice, publishSceneBridgeSnapshot, runExclusive, sceneBridgeBusy, sceneBridgePublication, sceneBridgeSession]);

  const refreshSceneBridgeProposals = useCallback(async () => {
    if (sceneBridgeBusy) throw new Error("Another Scene Bridge operation is still in progress.");
    const session = sceneBridgeSession;
    const client = agentGatewayRef.current;
    if (!session || !client) throw new Error("Create a Scene Bridge first.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      const records = await client.readBridgeProposals(session.sessionId);
      if (sessionIsCurrent()) setSceneBridgeProposals(records);
    } catch (error) {
      if (sessionIsCurrent()) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (sessionIsCurrent()) setSceneBridgeBusy(false);
    }
  }, [sceneBridgeBusy, sceneBridgeSession]);

  const discardSceneBridgeProposals = useCallback(async (throughCursor: number) => {
    if (sceneBridgeBusy) throw new Error("Another Scene Bridge operation is still in progress.");
    const session = sceneBridgeSession;
    const client = agentGatewayRef.current;
    if (!session || !client) throw new Error("Create a Scene Bridge first.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      await client.discardBridgeProposals(session.sessionId, throughCursor);
      if (sessionIsCurrent()) {
        setSceneBridgeProposals((current) => current.filter((record) => record.cursor > throughCursor));
      }
    } catch (error) {
      if (sessionIsCurrent()) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (sessionIsCurrent()) setSceneBridgeBusy(false);
    }
  }, [sceneBridgeBusy, sceneBridgeSession]);

  const applySceneBridgeProposal = useCallback(async (
    record: AgentBridgeProposalRecord,
    approvedChangeIds: readonly string[],
  ) => {
    if (busyRef.current || sceneBridgeBusy) throw new Error("Another Workspace operation is still in progress.");
    const session = sceneBridgeSession;
    const publication = sceneBridgePublication;
    const client = agentGatewayRef.current;
    const store = workspaceStoreRef.current;
    if (!session || !publication || !client || !store) throw new Error("The Scene Bridge is unavailable.");
    if (!approvedChangeIds.length) throw new Error("Select at least one eligible change to apply.");
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      await runExclusive(async () => {
        const state = store.getState();
        const review = reviewSemaFrameBridgeProposal(record.proposal, state, {
          expectedExchangeDigest: publication.digest,
          registry: DEFAULT_COMPONENT_REGISTRY,
        });
        const operations = approvedBridgeChangesToWorkspaceOperations(review, approvedChangeIds);
        applyWorkspaceOperations(
          [...operations],
          `Applied ${approvedChangeIds.length} reviewed ${session.target} Bridge change${approvedChangeIds.length === 1 ? "" : "s"}`,
          state.revision,
        );
        // Keep the reviewed proposal until the committed authoritative state
        // has been published. A failed publish then leaves an auditable stale
        // proposal instead of silently removing the recovery point.
        await publishSceneBridgeSnapshot(session, publication.sequence + 1);
        await client.discardBridgeProposals(session.sessionId, record.cursor);
        if (sessionIsCurrent()) {
          setSceneBridgeProposals((current) => current.filter((candidate) => candidate.cursor > record.cursor));
        }
      });
    } catch (error) {
      if (sessionIsCurrent()) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (sessionIsCurrent()) setSceneBridgeBusy(false);
    }
  }, [applyWorkspaceOperations, publishSceneBridgeSnapshot, runExclusive, sceneBridgeBusy, sceneBridgePublication, sceneBridgeSession]);

  const closeSceneBridgeSession = useCallback(async () => {
    if (sceneBridgeBusy) throw new Error("Another Scene Bridge operation is still in progress.");
    const session = sceneBridgeSession;
    const client = agentGatewayRef.current;
    if (!session || !client) return;
    const lifecycle = sceneBridgeLifecycleRef.current;
    const sessionIsCurrent = () => sceneBridgeLifecycleRef.current === lifecycle
      && sceneBridgeSessionRef.current?.sessionId === session.sessionId;
    let closedCurrentSession = false;
    setSceneBridgeBusy(true);
    setSceneBridgeError(undefined);
    try {
      try {
        await client.closeBridgeSession(session.sessionId);
      } catch (error) {
        if (!sceneBridgeAlreadyRevoked(error)) throw error;
      }
      if (!sessionIsCurrent()) return;
      sceneBridgeLifecycleRef.current += 1;
      closedCurrentSession = true;
      sceneBridgeSessionRef.current = undefined;
      setSceneBridgeSession(undefined);
      setSceneBridgePublication(undefined);
      setSceneBridgeProposals([]);
      notice("Scene Bridge closed and its bearer revoked.", "success");
    } catch (error) {
      if (sessionIsCurrent()) setSceneBridgeError(friendlyError(error));
      throw error;
    } finally {
      if (closedCurrentSession || sessionIsCurrent()) setSceneBridgeBusy(false);
    }
  }, [notice, sceneBridgeBusy, sceneBridgeSession]);

  const sceneBridgeProposalItems = useMemo<readonly SceneBridgeProposalItem[]>(() => {
    if (!sceneBridgePublication) return [];
    return sceneBridgeProposals.map((record) => Object.freeze({
      record,
      review: reviewSemaFrameBridgeProposal(record.proposal, workspace, {
        expectedExchangeDigest: sceneBridgePublication.digest,
        registry: DEFAULT_COMPONENT_REGISTRY,
      }),
    }));
  }, [sceneBridgeProposals, sceneBridgePublication, workspace]);

  /**
   * Commits deterministic host acknowledgements without presenting them as a
   * manual edit or adding them to the user's Undo history.
   * WorkspaceStore still persists/replays these system-authored operations.
   */
  const applyWorkspaceSystemOperations = useCallback((operations: WorkspaceOperation[]) => {
    const store = workspaceStoreRef.current;
    if (!store) throw new Error("The component workspace is not ready.");
    const state = store.getState();
    const batch: WorkspaceCommandBatch = {
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: uid("workspace_system"),
      workspace_id: state.workspaceId,
      input_revision: state.revision + 1,
      base_workspace_revision: state.revision,
      registry_digest: state.registryDigest,
      mode: "commit",
      operations,
    };
    const result = store.applyDetailed(batch, { actor: "system", permissions: ["*"] });
    setDirty(true);
    window.setTimeout(() => recoverySnapshotRef.current(), 0);
    return result;
  }, []);

  const createWorkspaceComponent = useCallback((typeId: string, options?: ComponentCreationOptions) => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const manifest = store.getComponentManifest(typeId);
      if (!manifest) throw new Error(`Unknown component type ${typeId}.`);
      const hasStage = [...store.getState().components.values()].some(
        (component) => component.type.typeId === "stage-3d",
      );
      if (typeId === "stage-3d" && hasStage) throw new Error("This workspace already owns its 3D stage.");
      const state = store.getState();
      const placement = defaultWorkspacePlacement(manifest, state.components.size, state);
      if (typeId === "spatial-primitive" && placement.space === "world3d" && options?.props?.geometry) {
        const bounds = deriveParametricBounds(parseParametricPrimitive(options.props.geometry));
        placement.position.y = -bounds.min.y;
      }
      if (typeId !== "stage-3d" && (placement.space === "world3d"
        || placement.space === "surface" || placement.space === "billboard") && !hasStage) {
        throw new Error("Add a 3D Stage before creating components in the 3D world.");
      }
      const [id] = store.reserveComponentIds(1);
      if (!id) throw new Error("The workspace could not reserve a component ID.");
      applyWorkspaceOperations([{
        op: "create_component",
        op_id: uid("op_create"),
        id,
        component_type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
        label: options?.label ?? manifest.displayName,
        ...(options?.props ? { props: structuredClone(options.props) } : {}),
        placement,
      }], `Added ${options?.label ?? manifest.displayName}`);
      setSelectedComponentId(id);
      return id;
    } catch (error) {
      notice(friendlyError(error), "error");
      return undefined;
    }
  }, [applyWorkspaceOperations, notice]);

  const putRealityAssetBytes = useCallback(async (
    candidate: RealityAssetCandidate,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<Readonly<{ descriptor: RealityAssetDescriptor; previouslyAvailable: boolean }>> => {
    const vault = realityAssetVaultRef.current!.vault;
    let previouslyAvailable = false;
    try {
      const existing = await vault.open(candidate.descriptor.assetId);
      previouslyAvailable = existing.size === candidate.descriptor.byteLength;
    } catch {
      previouslyAvailable = false;
    }
    if (!previouslyAvailable) await vault.delete(candidate.descriptor.assetId).catch(() => false);
    const stored = await vault.put(candidate, blob, { signal });
    return { descriptor: stored.descriptor, previouslyAvailable };
  }, []);

  const announceRealityAssetCompletion = useCallback((
    completion: AppRealityAssetCompletion,
    source: RealityAssetCompletionSource = "agent",
  ) => {
    if (source === "agent") {
      setEntries((current) => current.some((entry) => entry.id === completion.requestId) ? current : [...current, {
        id: completion.requestId,
        inputRevision: completion.inputRevision,
        text: "Agent imported a verified visual-only Reality asset",
        status: "committed",
        source: "agent",
        clientName: agentGatewayRef.current?.config?.clientName,
        traceId: completion.requestId,
        summary: "Imported a verified visual-only Reality asset",
      }]);
    }
    setRealityAssetAvailability((values) => ({
      ...values,
      [completion.descriptor.assetId]: "available",
    }));
    setRealityRenderGeneration((generation) => generation + 1);
    if (source === "agent") {
      setRealityImportStatus("Agent import verified and stored. The asset is ready for a Gaussian Splat component.");
    } else {
      setPhotoReconstructionStatus("Reconstruction verified and stored. Creating an editable Reality layer…");
    }
    notice(source === "agent"
      ? "Agent imported a verified visual-only Reality asset."
      : "Photo reconstruction passed browser preflight and was stored locally.", "success");
  }, [notice, setEntries]);

  const completeRealityAssetImport = useCallback(async (
    candidateHandle: string,
    source: RealityAssetCompletionSource = "agent",
  ): Promise<JSONObject> => {
    const completed = await runExclusive(async () => {
      const client = agentGatewayRef.current;
      const store = workspaceStoreRef.current;
      if (!client || !store) throw new Error("The authoritative browser importer is unavailable.");
      const initialState = store.getState();
      const workspaceId = initialState.workspaceId;
      const baseRevision = initialState.revision;
      const workspaceGeneration = workspaceGenerationRef.current;
      const completionContext = `${workspaceGeneration}:${workspaceId}`;
      const priorCompletion = realityAssetCompletionLedgerRef.current.peekCompleted(
        candidateHandle,
        completionContext,
      );
      if (priorCompletion) {
        assertRealityAssetCandidatePurpose(priorCompletion.purpose, source);
        const registered = store.getState().realityAssets.get(priorCompletion.descriptor.assetId);
        if (!registered || registered.digest !== priorCompletion.descriptor.digest) {
          realityAssetCompletionLedgerRef.current.abandon(candidateHandle);
          throw new Error("The completed Reality Asset is no longer registered in this Workspace.");
        }
        announceRealityAssetCompletion(priorCompletion, source);
        return structuredClone(priorCompletion.result);
      }
      const pendingCompletion = realityAssetCompletionLedgerRef.current.peek(
        candidateHandle,
        completionContext,
      );
      if (pendingCompletion) {
        assertRealityAssetCandidatePurpose(pendingCompletion.purpose, source);
        const registered = store.getState().realityAssets.get(pendingCompletion.descriptor.assetId);
        if (!registered || registered.digest !== pendingCompletion.descriptor.digest) {
          realityAssetCompletionLedgerRef.current.abandon(candidateHandle);
          throw new Error("The locally completed Reality Asset is no longer registered in this Workspace.");
        }
        const retried = await realityAssetCompletionLedgerRef.current.acknowledgeRetry(
          candidateHandle,
          completionContext,
          () => client.completeAssetCandidate(candidateHandle, workspaceId),
        );
        if (!retried) throw new Error("The pending Reality Asset completion was not available for retry.");
        announceRealityAssetCompletion(retried, source);
        return structuredClone(retried.result);
      }
      let stored: Awaited<ReturnType<typeof putRealityAssetBytes>> | undefined;
      let registeredNow = false;
      let hadRegistration = false;
      let retainCandidateOnFailure = source === "photo-reconstruction";
      try {
        const inspected = await client.inspectAssetCandidate(candidateHandle, workspaceId);
        assertRealityAssetCandidatePurpose(inspected.purpose, source);
        const opened = await client.openAssetCandidate(candidateHandle, workspaceId);
        if (opened.descriptor.purpose !== inspected.purpose) {
          await opened.body.cancel().catch(() => undefined);
          assertRealityAssetCandidatePurpose(opened.descriptor.purpose, source);
          throw new Error("The staged Reality asset purpose changed between inspection and streaming.");
        }
        assertRealityAssetCandidatePurpose(opened.descriptor.purpose, source);
        if (opened.descriptor.candidateHandle !== inspected.candidateHandle
          || opened.descriptor.sha256 !== inspected.sha256
          || opened.descriptor.byteLength !== inspected.byteLength
          || opened.descriptor.format !== inspected.format) {
          await opened.body.cancel().catch(() => undefined);
          retainCandidateOnFailure = false;
          throw new Error("The staged Reality asset changed between inspection and streaming.");
        }
        const blob = await new Response(opened.body, {
          headers: { "Content-Type": inspected.mediaType },
        }).blob();
        if (blob.size !== inspected.byteLength) {
          retainCandidateOnFailure = false;
          throw new Error("The staged Reality asset stream ended at the wrong byte length.");
        }
        let candidate: RealityAssetCandidate;
        try {
          candidate = await preflightRealityAssetInWorker(blob);
        } catch (error) {
          retainCandidateOnFailure = false;
          throw error;
        }
        const expectedFormat = inspected.format === "spz"
          ? "spz-v4"
          : inspected.format === "sog" ? "sog-v2" : "ply";
        if (candidate.descriptor.digest !== inspected.sha256
          || candidate.descriptor.byteLength !== inspected.byteLength
          || candidate.descriptor.format !== expectedFormat) {
          retainCandidateOnFailure = false;
          throw new Error("The staged Reality asset metadata does not match browser preflight.");
        }

        if (workspaceStoreRef.current !== store
          || workspaceGenerationRef.current !== workspaceGeneration
          || store.getState().workspaceId !== workspaceId
          || store.getState().revision !== baseRevision) {
          retainCandidateOnFailure = false;
          throw new Error("The project changed while the staged Reality asset was being verified.");
        }

        stored = await putRealityAssetBytes(candidate, blob);
        const registered = store.getState().realityAssets.get(candidate.descriptor.assetId);
        hadRegistration = Boolean(registered);
        if (registered && registered.digest !== candidate.descriptor.digest) {
          retainCandidateOnFailure = false;
          throw new Error("The staged content conflicts with registered Reality asset metadata.");
        }
        if (!registered) {
          applyWorkspaceSystemOperations([{
            op: "register_reality_asset",
            op_id: uid("op_agent_register_reality"),
            asset: structuredClone(candidate.descriptor),
          }]);
          registeredNow = true;
        }

        if (workspaceStoreRef.current !== store
          || workspaceGenerationRef.current !== workspaceGeneration
          || store.getState().workspaceId !== workspaceId) {
          retainCandidateOnFailure = false;
          throw new Error("The project changed before the staged Reality asset could be finalized.");
        }
        const result = {
          asset_ref: {
            asset_id: candidate.descriptor.assetId,
            digest: candidate.descriptor.digest,
          },
          descriptor: structuredClone(candidate.descriptor),
          warnings: [...candidate.warnings],
        } as unknown as JSONObject;
        const completion: AppRealityAssetCompletion = {
          requestId: inspected.requestId,
          inputRevision: store.getState().revision,
          purpose: inspected.purpose,
          descriptor: structuredClone(candidate.descriptor),
          result,
        };
        await realityAssetCompletionLedgerRef.current.acknowledgeFirst(
          candidateHandle,
          completionContext,
          completion,
          () => client.completeAssetCandidate(candidateHandle, workspaceId),
        );
        announceRealityAssetCompletion(completion, source);
        return structuredClone(result);
      } catch (error) {
        const preservedCompletion = realityAssetCompletionLedgerRef.current.peek(
          candidateHandle,
          completionContext,
        );
        if (preservedCompletion) {
          // The browser has already verified and durably committed the exact
          // content. A status-less/lost gateway acknowledgement is ambiguous:
          // retain the local source of truth and let an identical tool retry
          // consume the server's idempotent completion tombstone.
          announceRealityAssetCompletion(preservedCompletion, source);
          throw source === "photo-reconstruction" && !(error instanceof RetainedRealityAssetCandidateError)
            ? new RetainedRealityAssetCandidateError(friendlyError(error), { cause: error })
            : error;
        }
        // Best-effort transaction rollback: failed completion must not leave a
        // newly registered descriptor or newly written local bytes behind.
        if (registeredNow && workspaceStoreRef.current === store) {
          const current = store.getState();
          const referenced = [...current.components.values()].some((component) =>
            realityAssetReference(component.props.assetRef)?.assetId === stored?.descriptor.assetId);
          if (!referenced && stored && current.realityAssets.has(stored.descriptor.assetId)) {
            try {
              applyWorkspaceSystemOperations([{
                op: "delete_reality_asset",
                op_id: uid("op_rollback_agent_reality"),
                asset_id: stored.descriptor.assetId,
                confirm: true,
              }]);
              registeredNow = false;
            } catch {
              // Preserve the registered descriptor if a concurrent reference
              // made rollback unsafe; its digest-verified bytes stay usable.
            }
          }
        }
        if (stored && !stored.previouslyAvailable && !hadRegistration && !registeredNow) {
          await realityAssetVaultRef.current!.vault.delete(stored.descriptor.assetId).catch(() => false);
        }
        const failureStatus = (error as { status?: unknown } | null)?.status;
        if (typeof failureStatus === "number" && failureStatus >= 400 && failureStatus < 500
          && ![408, 409, 425, 429].includes(failureStatus)) {
          retainCandidateOnFailure = false;
        }
        const retainCandidate = error instanceof RetainedRealityAssetCandidateError || retainCandidateOnFailure;
        if (!retainCandidate) {
          await client.cancelAssetCandidate(candidateHandle, workspaceId).catch(() => undefined);
          throw error;
        }
        throw error instanceof RetainedRealityAssetCandidateError
          ? error
          : new RetainedRealityAssetCandidateError(friendlyError(error), { cause: error });
      }
    });
    if (!completed) throw new Error("Another Workspace operation is still in progress.");
    return completed;
  }, [announceRealityAssetCompletion, applyWorkspaceSystemOperations, putRealityAssetBytes, runExclusive]);
  completeRealityAssetImportRef.current = completeRealityAssetImport;

  const placeReconstructedRealityLayer = useCallback(async (
    descriptor: RealityAssetDescriptor,
    label: string,
    expectedWorkspaceId: string,
    expectedGeneration: number,
  ): Promise<void> => {
    const placed = await runExclusive(async () => {
      const store = workspaceStoreRef.current;
      if (!store || store.getState().workspaceId !== expectedWorkspaceId ||
          workspaceGenerationRef.current !== expectedGeneration) {
        throw new Error("The project changed before the reconstructed Reality layer could be placed.");
      }
      const state = store.getState();
      const registered = state.realityAssets.get(descriptor.assetId);
      if (!registered || registered.digest !== descriptor.digest) {
        throw new Error("The reconstructed Reality asset is no longer registered in this project.");
      }
      const hasStage = [...state.components.values()].some((component) => component.type.typeId === "stage-3d");
      const stageManifest = hasStage ? undefined : store.getComponentManifest("stage-3d");
      const realityManifest = store.getComponentManifest("gaussian-splat");
      if (!realityManifest) throw new Error("The built-in Gaussian Splat Reality Layer is unavailable.");
      if (!hasStage && !stageManifest) throw new Error("The built-in 3D Stage is unavailable.");
      const ids = store.reserveComponentIds(hasStage ? 1 : 2);
      const stageId = hasStage ? undefined : ids[0];
      const realityId = ids[hasStage ? 0 : 1];
      if (!realityId || (!hasStage && !stageId)) throw new Error("The workspace could not reserve Reality component IDs.");
      const operations: WorkspaceOperation[] = [];
      if (stageId && stageManifest) operations.push({
        op: "create_component",
        op_id: uid("op_reconstruction_stage"),
        id: stageId,
        component_type: {
          typeId: stageManifest.typeId,
          version: stageManifest.version,
          digest: stageManifest.digest,
        },
        label: "3D Stage",
        placement: defaultWorkspacePlacement(stageManifest, state.components.size, state),
      });
      operations.push({
        op: "create_component",
        op_id: uid("op_reconstruction_layer"),
        id: realityId,
        component_type: {
          typeId: realityManifest.typeId,
          version: realityManifest.version,
          digest: realityManifest.digest,
        },
        label,
        props: {
          assetRef: { assetId: descriptor.assetId, digest: descriptor.digest },
          calibration: {
            version: 1,
            status: "uncalibrated",
            sourceCoordinateSystem: descriptor.coordinateSystem.system,
            targetCoordinateSystem: "RUB",
            metersPerSourceUnit: null,
          },
          quality: "auto",
          semanticProxyIds: [],
        },
        placement: defaultWorkspacePlacement(realityManifest, state.components.size + (stageId ? 1 : 0), state),
        tags: ["reality", "visual-reference", "photo-reconstruction"],
      });
      applyWorkspaceOperations(operations, "Placed an editable photo reconstruction");
      setSelectedComponentId(realityId);
      window.setTimeout(() => hybridCanvasRef.current?.frameAll(), 120);
      return true;
    });
    if (!placed) throw new Error("Another Workspace operation is still in progress.");
  }, [applyWorkspaceOperations, runExclusive]);

  const importRealityAssetFile = useCallback(async (file: File, relinkAssetId?: string) => {
    await runExclusive(async () => {
      const controller = new AbortController();
      realityImportAbortRef.current?.abort();
      realityImportAbortRef.current = controller;
      setRealityImportBusy(true);
      setRealityImportStatus(relinkAssetId ? "Verifying exact replacement content…" : "Inspecting format, bounds, and digest…");
      let stored: Awaited<ReturnType<typeof putRealityAssetBytes>> | undefined;
      let keepStoredBytesOnFailure = false;
      try {
        const store = workspaceStoreRef.current;
        if (!store) throw new Error("The component workspace is not ready.");
        const expected = relinkAssetId ? store.getState().realityAssets.get(relinkAssetId) : undefined;
        if (relinkAssetId && !expected) throw new Error("The Reality asset is no longer registered in this project.");

        const candidate = await preflightRealityAssetInWorker(file, { signal: controller.signal });
        if (expected && (candidate.descriptor.assetId !== expected.assetId
          || candidate.descriptor.digest !== expected.digest)) {
          throw new Error("That file is different content. Relink requires the exact registered SHA-256 digest.");
        }

        stored = await putRealityAssetBytes(candidate, file, controller.signal);
        if (expected) {
          const current = store.getState().realityAssets.get(expected.assetId);
          if (!current || current.digest !== expected.digest) {
            throw new Error("The project changed while the Reality asset was being relinked.");
          }
          keepStoredBytesOnFailure = true;
          setRealityAssetAvailability((values) => ({ ...values, [expected.assetId]: "available" }));
          setRealityRenderGeneration((generation) => generation + 1);
          setRealityImportStatus("Exact asset relinked. The visual layer is loading from local storage.");
          notice("Reality asset relinked by exact content digest.", "success");
          return;
        }

        const state = store.getState();
        const registered = state.realityAssets.get(candidate.descriptor.assetId);
        if (registered && registered.digest !== candidate.descriptor.digest) {
          throw new Error("This content-addressed asset ID conflicts with registered project metadata.");
        }
        keepStoredBytesOnFailure = Boolean(registered);
        const hasStage = [...state.components.values()].some((component) => component.type.typeId === "stage-3d");
        const stageManifest = hasStage ? undefined : store.getComponentManifest("stage-3d");
        const realityManifest = store.getComponentManifest("gaussian-splat");
        if (!realityManifest) throw new Error("The built-in Gaussian Splat Reality Layer is unavailable.");
        if (!hasStage && !stageManifest) throw new Error("The built-in 3D Stage is unavailable.");
        const ids = store.reserveComponentIds(hasStage ? 1 : 2);
        const stageId = hasStage ? undefined : ids[0];
        const realityId = ids[hasStage ? 0 : 1];
        if (!realityId || (!hasStage && !stageId)) throw new Error("The workspace could not reserve Reality component IDs.");

        const operations: WorkspaceOperation[] = [];
        if (!registered) operations.push({
          op: "register_reality_asset",
          op_id: uid("op_register_reality"),
          asset: structuredClone(candidate.descriptor),
        });
        if (stageId && stageManifest) operations.push({
          op: "create_component",
          op_id: uid("op_create_reality_stage"),
          id: stageId,
          component_type: {
            typeId: stageManifest.typeId,
            version: stageManifest.version,
            digest: stageManifest.digest,
          },
          label: "3D Stage",
          placement: defaultWorkspacePlacement(stageManifest, state.components.size, state),
        });
        operations.push({
          op: "create_component",
          op_id: uid("op_create_reality_layer"),
          id: realityId,
          component_type: {
            typeId: realityManifest.typeId,
            version: realityManifest.version,
            digest: realityManifest.digest,
          },
          label: `Reality capture ${[...state.components.values()].filter((component) => component.type.typeId === "gaussian-splat").length + 1}`,
          props: {
            assetRef: {
              assetId: candidate.descriptor.assetId,
              digest: candidate.descriptor.digest,
            },
            calibration: {
              version: 1,
              status: "uncalibrated",
              sourceCoordinateSystem: candidate.descriptor.coordinateSystem.system,
              targetCoordinateSystem: "RUB",
              metersPerSourceUnit: null,
            },
            quality: "auto",
            semanticProxyIds: [],
          },
          placement: defaultWorkspacePlacement(realityManifest, state.components.size + (stageId ? 1 : 0), state),
          tags: ["reality", "visual-reference"],
        });

        applyWorkspaceOperations(operations, "Imported a visual-only Reality capture");
        keepStoredBytesOnFailure = true;
        setSelectedComponentId(realityId);
        setRealityAssetAvailability((values) => ({ ...values, [candidate.descriptor.assetId]: "available" }));
        setRealityImportStatus(candidate.warnings.length
          ? `Imported with ${candidate.warnings.length} preflight ${candidate.warnings.length === 1 ? "warning" : "warnings"}. Calibrate before metric use.`
          : "Imported safely. Calibrate scale and link engineering proxies in Inspector.");
        window.setTimeout(() => hybridCanvasRef.current?.frameAll(), 120);
      } catch (error) {
        if (stored && !stored.previouslyAvailable && !keepStoredBytesOnFailure) {
          await realityAssetVaultRef.current!.vault.delete(stored.descriptor.assetId).catch(() => false);
        }
        const message = friendlyError(error);
        setRealityImportStatus(message);
        notice(`Reality asset import failed: ${message}`, "error");
      } finally {
        if (realityImportAbortRef.current === controller) realityImportAbortRef.current = null;
        setRealityImportBusy(false);
      }
    });
  }, [applyWorkspaceOperations, notice, putRealityAssetBytes, runExclusive]);

  const chooseRealityAssetFile = useCallback((relinkAssetId?: string) => {
    pendingRealityRelinkRef.current = relinkAssetId ?? null;
    realityFileRef.current?.click();
  }, []);

  const reconstructPhotoSet = useCallback(async (files: readonly File[]) => {
    const client = agentGatewayRef.current;
    const store = workspaceStoreRef.current;
    if (!client || !store) {
      notice("The local photo reconstruction gateway is unavailable.", "error");
      return;
    }
    if (photoReconstructionCapability === "checking") {
      notice("Photo reconstruction capability is still being checked.", "warning");
      return;
    }
    if (!photoReconstructionCapability.available) {
      notice(photoReconstructionCapability.reason ?? "Photo reconstruction is unavailable on this machine.", "error");
      return;
    }
    if (files.length < PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount ||
        files.length > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount) {
      notice(`Choose ${PHOTO_RECONSTRUCTION_LIMITS.minimumPhotoCount}-${PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoCount} overlapping photos.`, "error");
      return;
    }

    const previousReconstruction = activePhotoReconstructionRef.current;
    photoReconstructionAbortRef.current?.abort();
    if (previousReconstruction) {
      setPhotoReconstructionStatus("Cancelling the previous photo reconstruction before starting a new one…");
      try {
        await confirmTrackedPhotoReconstructionCancellation(previousReconstruction);
      } catch (error) {
        const message = `Warning: the previous job remains tracked because cancellation could not be confirmed. ${friendlyError(error)}`;
        setPhotoReconstructionStatus(message);
        notice(message, "warning");
        return;
      }
    }
    if (workspaceStoreRef.current !== store) {
      notice("The project changed before photo reconstruction could start.", "warning");
      return;
    }

    const workspaceId = store.getState().workspaceId;
    const workspaceGeneration = workspaceGenerationRef.current;
    const controller = new AbortController();
    photoReconstructionAbortRef.current = controller;
    setRealityImportBusy(true);
    setPhotoReconstructionBusy(true);
    setPhotoReconstructionJob(undefined);
    let completed = false;
    let activeJobId: string | undefined;
    try {
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetBytes) {
        throw new Error(`The photo set exceeds the ${Math.round(PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoSetBytes / 1_073_741_824)} GiB limit.`);
      }
      const photos: Array<{
        photoId: string;
        mediaType: PhotoReconstructionMediaType;
        byteLength: number;
        sha256: `sha256:${string}`;
      }> = [];
      const fileByPhotoId = new Map<string, File>();
      const seenDigests = new Set<string>();
      for (const [index, file] of files.entries()) {
        if (file.size < 1 || file.size > PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes) {
          throw new Error(`Photo ${index + 1} must be between 1 byte and 64 MiB.`);
        }
        const mediaType = reconstructionPhotoMediaType(file);
        if (!mediaType) throw new Error(`Photo ${index + 1} is not JPEG, PNG, WebP, HEIC, or HEIF.`);
        setPhotoReconstructionStatus(`Hashing photo ${index + 1} of ${files.length}…`);
        const sha256 = await digestBlobSha256(file, {
          signal: controller.signal,
          maximumBytes: PHOTO_RECONSTRUCTION_LIMITS.maximumPhotoBytes,
        });
        if (seenDigests.has(sha256)) {
          throw new Error(`Photo ${index + 1} duplicates another selected image. Remove duplicate views and try again.`);
        }
        seenDigests.add(sha256);
        const photoId = `photo_${String(index + 1).padStart(4, "0")}`;
        photos.push({ photoId, mediaType, byteLength: file.size, sha256 });
        fileByPhotoId.set(photoId, file);
      }
      if (workspaceStoreRef.current !== store || store.getState().workspaceId !== workspaceId ||
          workspaceGenerationRef.current !== workspaceGeneration) {
        throw new DOMException("The project changed during photo preparation", "AbortError");
      }

      setPhotoReconstructionStatus(`Preparing ${files.length} verified photo uploads…`);
      const begun = await client.beginPhotoReconstruction({
        requestId: uid("photo_reconstruction"),
        workspaceId,
        profile: photoReconstructionProfile,
        photos,
      }, controller.signal);
      activeJobId = begun.job.jobId;
      activePhotoReconstructionRef.current = { jobId: begun.job.jobId, workspaceId };
      setPhotoReconstructionJob(begun.job);
      if (begun.uploads.length !== files.length) {
        throw new Error("The reconstruction gateway returned an incomplete photo upload plan.");
      }

      let job = begun.job;
      for (const [index, grant] of begun.uploads.entries()) {
        const file = fileByPhotoId.get(grant.photoId);
        if (!file) throw new Error("A photo upload grant did not match the selected photo set.");
        setPhotoReconstructionStatus(`Uploading verified photo ${index + 1} of ${begun.uploads.length}…`);
        job = await client.uploadPhotoReconstructionGrant(grant, file, controller.signal);
        setPhotoReconstructionJob(job);
      }

      setPhotoReconstructionStatus("Starting local camera solve…");
      job = await client.startPhotoReconstruction(job.jobId, workspaceId, controller.signal);
      setPhotoReconstructionJob(job);
      while (!["ready", "failed", "cancelled"].includes(job.status)) {
        await abortableDelay(1_000, controller.signal);
        job = await client.inspectPhotoReconstruction(job.jobId, workspaceId, controller.signal);
        setPhotoReconstructionJob(job);
        const percent = Math.round(job.progress * 100);
        setPhotoReconstructionStatus(`${job.status.replaceAll("_", " ")} · ${percent}%`);
      }
      if (job.status === "failed") throw new Error(job.error?.message ?? "Photo reconstruction failed.");
      if (job.status === "cancelled") throw new DOMException("Photo reconstruction cancelled", "AbortError");
      if (!job.result) throw new Error("Photo reconstruction finished without an output candidate.");

      setPhotoReconstructionStatus("Verifying reconstructed Reality bytes in the browser…");
      const candidate = await client.finalizePhotoReconstruction(
        job.jobId,
        workspaceId,
        `photo-reconstruction-${job.jobId.slice(0, 8)}.ply`,
        job.result.sha256,
        controller.signal,
      );
      let completion: JSONObject;
      try {
        completion = await completeRealityAssetImport(candidate.candidateHandle, "photo-reconstruction");
      } catch (error) {
        if (!(error instanceof RetainedRealityAssetCandidateError)) throw error;
        // A lost/ambiguous browser acknowledgement is the common retry case.
        // Retry once through the same purpose-bound ledger before exposing a
        // failure; this also makes an already-durable local commit idempotent.
        setPhotoReconstructionStatus("Browser acknowledgement was interrupted. Retrying the verified Reality handoff once…");
        completion = await completeRealityAssetImport(candidate.candidateHandle, "photo-reconstruction");
      }
      const assetRef = completion.asset_ref;
      if (!assetRef || typeof assetRef !== "object" || Array.isArray(assetRef)) {
        throw new Error("Browser preflight did not return a reconstructed asset reference.");
      }
      const assetId = (assetRef as Record<string, unknown>).asset_id;
      const digest = (assetRef as Record<string, unknown>).digest;
      if (typeof assetId !== "string" || typeof digest !== "string") {
        throw new Error("Browser preflight returned an invalid reconstructed asset reference.");
      }
      const descriptor = workspaceStoreRef.current?.getState().realityAssets.get(assetId);
      if (!descriptor || descriptor.digest !== digest) {
        throw new Error("The reconstructed Reality asset was not registered after browser preflight.");
      }
      const ordinal = [...store.getState().components.values()]
        .filter((component) => component.type.typeId === "gaussian-splat").length + 1;
      await placeReconstructedRealityLayer(
        descriptor,
        `Photo reconstruction ${ordinal}`,
        workspaceId,
        workspaceGeneration,
      );
      completed = true;
      activePhotoReconstructionRef.current = null;
      setPhotoReconstructionStatus("Photo reconstruction is editable in the Workspace. Calibrate scale and link engineering proxies before metric use.");
      notice("Photo set reconstructed into an editable visual-only Reality layer.", "success");
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (photoReconstructionAbortRef.current === controller) {
        setPhotoReconstructionStatus(aborted ? "Photo reconstruction cancellation requested…" : friendlyError(error));
        if (!aborted) notice(`Photo reconstruction failed after its bounded browser retry: ${friendlyError(error)}`, "error");
      }
    } finally {
      const active = activePhotoReconstructionRef.current;
      if (!completed && activeJobId && active?.jobId === activeJobId && active.workspaceId === workspaceId) {
        try {
          await confirmTrackedPhotoReconstructionCancellation(active);
          if (photoReconstructionAbortRef.current === controller) {
            setPhotoReconstructionStatus("Photo reconstruction cancelled and temporary inputs deleted.");
          }
        } catch (error) {
          if (photoReconstructionAbortRef.current === controller) {
            const message = `Warning: cancellation could not be confirmed; the job remains tracked. ${friendlyError(error)}`;
            setPhotoReconstructionStatus(message);
            notice(message, "warning");
          }
        }
      }
      if (photoReconstructionAbortRef.current === controller) {
        photoReconstructionAbortRef.current = null;
        const stillTracked = activeJobId !== undefined
          && activePhotoReconstructionRef.current?.jobId === activeJobId
          && activePhotoReconstructionRef.current.workspaceId === workspaceId;
        if (!stillTracked) {
          setRealityImportBusy(false);
          setPhotoReconstructionBusy(false);
        }
      }
    }
  }, [
    completeRealityAssetImport,
    confirmTrackedPhotoReconstructionCancellation,
    notice,
    photoReconstructionCapability,
    photoReconstructionProfile,
    placeReconstructedRealityLayer,
  ]);

  const choosePhotoSet = useCallback(() => {
    photoSetFileRef.current?.click();
  }, []);

  const cancelPhotoReconstruction = useCallback(async () => {
    const active = activePhotoReconstructionRef.current;
    photoReconstructionAbortRef.current?.abort();
    if (!active) return;
    setPhotoReconstructionStatus("Cancelling photo reconstruction and deleting temporary inputs…");
    try {
      await confirmTrackedPhotoReconstructionCancellation(active);
      setPhotoReconstructionStatus("Photo reconstruction cancelled and temporary inputs deleted.");
    } catch (error) {
      const message = `Warning: photo reconstruction cancellation could not be confirmed; the job remains tracked. ${friendlyError(error)}`;
      setPhotoReconstructionStatus(message);
      notice(message, "warning");
    }
  }, [confirmTrackedPhotoReconstructionCancellation, notice]);

  const deleteRealityAsset = useCallback(async (assetId: string): Promise<boolean> => {
    const result = await runExclusive(async () => {
      try {
        const state = workspaceStoreRef.current?.getState();
        const descriptor = state?.realityAssets.get(assetId);
        if (!state || !descriptor) throw new Error("The Reality asset is no longer registered.");
        const references = [...state.components.values()].filter((component) => {
          const reference = realityAssetReference(component.props.assetRef);
          return reference?.assetId === descriptor.assetId && reference.digest === descriptor.digest;
        });
        if (references.length > 0) throw new Error("Delete every Reality layer instance before deleting its asset metadata.");
        applyWorkspaceOperations([{
          op: "delete_reality_asset",
          op_id: uid("op_delete_reality"),
          asset_id: descriptor.assetId,
          confirm: true,
        }], "Deleted an unreferenced Reality asset");
        setRealityAssetAvailability((current) => Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== descriptor.assetId),
        ));
        setRealityImportStatus("Removed project metadata. Content-addressed local bytes remain cached for other projects.");
        return true;
      } catch (error) {
        notice(friendlyError(error), "error");
        return false;
      }
    });
    return result === true;
  }, [applyWorkspaceOperations, notice, runExclusive]);

  const createWorkspaceModelAssembly = useCallback((componentId: string) => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const component = store.getState().components.get(componentId);
      if (!component) throw new Error(`Unknown component ${componentId}.`);
      if (component.placement.space !== "world3d" || component.type.typeId === "stage-3d") {
        throw new Error("Only a 3D object can be wrapped in a model assembly.");
      }
      if (component.locks.placement) throw new Error(`${component.label} placement is locked.`);
      const assembly = store.getComponentManifest("model-assembly");
      if (!assembly) throw new Error("The built-in model assembly is unavailable.");
      const [assemblyId] = store.reserveComponentIds(1);
      if (!assemblyId) throw new Error("The workspace could not reserve an assembly ID.");
      applyWorkspaceOperations([{
        op: "create_component",
        op_id: uid("op_create_assembly"),
        id: assemblyId,
        component_type: { typeId: assembly.typeId, version: assembly.version, digest: assembly.digest },
        label: `${component.label} model`,
        props: { description: `Editable assembly containing ${component.label}.`, collisionPolicy: "external_only" },
        placement: {
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        ...(component.parentId ? { parent_id: component.parentId } : {}),
        tags: ["model", "assembly"],
      }, {
        op: "attach_component",
        op_id: uid("op_attach_assembly_part"),
        child_id: component.id,
        parent_id: assemblyId,
        transform_mode: "preserve_world",
      }], `Created model assembly for ${component.label}`);
      setSelectedComponentId(assemblyId);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const transformWorkspaceComponent = useCallback((request: WorkspaceComponentTransformRequest): void => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const state = store.getState();
      const component = state.components.get(request.componentId);
      if (!component) throw new Error(`Unknown component ${request.componentId}.`);
      if (component.placement.space !== "world3d") throw new Error(`${component.label} does not use a 3D world transform.`);
      if (component.locks.placement) throw new Error(`${component.label} placement is locked.`);

      // Treat the requested transform as a root pose, then derive the exact
      // local placement required beneath the component's current parent.
      const desiredComponent = structuredClone(component);
      delete desiredComponent.parentId;
      desiredComponent.placement = structuredClone(request.worldPlacement);
      const desiredWorld = resolveComponentWorldTransform(
        new Map([[desiredComponent.id, desiredComponent]]),
        desiredComponent.id,
      );
      const parentWorld = component.parentId
        ? resolveComponentWorldTransform(state.components, component.parentId)
        : undefined;
      const localPlacement = localPlacementForWorldTransform(desiredWorld, parentWorld);
      applyWorkspaceOperations([{
        op: "place_component",
        op_id: uid("op_transform_model_component"),
        id: component.id,
        placement: localPlacement,
      }], `Positioned ${component.label} exactly`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const reparentWorkspaceComponent = useCallback((request: WorkspaceComponentHierarchyRequest): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const state = store.getState();
      const component = state.components.get(request.componentId);
      if (!component) throw new Error(`Unknown component ${request.componentId}.`);
      if (component.placement.space !== "world3d") throw new Error(`${component.label} is not a 3D component.`);
      if (component.locks.placement) throw new Error(`${component.label} placement is locked.`);
      if (request.parentId === component.parentId) return true;
      if (request.parentId) {
        const parent = state.components.get(request.parentId);
        if (!parent || parent.type.typeId !== "model-assembly" || parent.placement.space !== "world3d") {
          throw new Error("Choose an existing 3D model assembly as the parent.");
        }
        applyWorkspaceOperations([{
          op: "attach_component",
          op_id: uid("op_attach_model_component"),
          child_id: component.id,
          parent_id: parent.id,
          transform_mode: "preserve_world",
        }], `Attached ${component.label} to ${parent.label} without moving it`);
      } else if (component.parentId) {
        applyWorkspaceOperations([{
          op: "detach_component",
          op_id: uid("op_detach_model_component"),
          child_id: component.id,
          transform_mode: "preserve_world",
        }], `Detached ${component.label} without moving it`);
      }
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const deleteWorkspaceComponent = useCallback((componentId: string): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const component = store.getState().components.get(componentId);
      if (!component) throw new Error(`Unknown component ${componentId}.`);
      if (component.type.typeId === "stage-3d") throw new Error("Delete the stage through the project lifecycle, not the model editor.");
      if (component.locks.deletion) throw new Error(`${component.label} deletion is locked.`);
      applyWorkspaceOperations([{
        op: "delete_component",
        op_id: uid("op_delete_model_component"),
        id: component.id,
        policy: "cascade",
        confirm: true,
      }], `Deleted ${component.label}${component.props.modelRef ? " instance" : ""}`);
      setSelectedComponentId(null);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const publishWorkspaceModel = useCallback((request: WorkspaceModelPublishRequest): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const root = store.getState().components.get(request.rootId);
      if (!root || root.type.typeId !== "model-assembly") {
        throw new Error("Select an existing model assembly before publishing.");
      }
      applyWorkspaceOperations([{
        op: "publish_model",
        op_id: uid("op_publish_model"),
        model_id: request.modelId,
        version: request.version,
        display_name: request.displayName,
        root_id: request.rootId,
      }], `Published ${request.displayName} ${request.version}`);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const instantiateWorkspaceModel = useCallback((requested: ModelDefinition): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const state = store.getState();
      const key = `${requested.modelId}@${requested.version}`;
      const definition = state.modelDefinitions.get(key);
      if (!definition || definition.digest !== requested.digest) {
        throw new Error(`${key} is no longer the published model shown in this panel.`);
      }
      if (![...state.components.values()].some((component) => component.type.typeId === "stage-3d")) {
        throw new Error("Add a 3D Stage before instantiating a model.");
      }
      if (state.components.size + definition.nodes.length > MAX_WORKSPACE_COMPONENTS) {
        throw new Error(`This model would exceed the ${MAX_WORKSPACE_COMPONENTS}-component workspace limit.`);
      }
      const reservedIds = store.reserveComponentIds(definition.nodes.length);
      const plan = planWorkspaceModelInstance(state, definition, reservedIds);
      applyWorkspaceOperations([{
        op: "instantiate_model",
        op_id: uid("op_instantiate_model"),
        model: modelDefinitionRef(definition),
        id_map: plan.idMap,
        root_placement: plan.rootPlacement,
      }], `Added ${definition.displayName} instance`);
      setSelectedComponentId(plan.rootComponentId);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const createParametricWorkbench = useCallback((): void => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const state = store.getState();
      const existing = state.modelDefinitions.get("com.semaframe.parametric-workbench@1.0.0");
      if (existing) {
        instantiateWorkspaceModel(existing);
        return;
      }
      const stageManifest = store.getComponentManifest("stage-3d");
      const assemblyManifest = store.getComponentManifest("model-assembly");
      const primitiveManifest = store.getComponentManifest("spatial-primitive");
      if (!stageManifest || !assemblyManifest || !primitiveManifest) {
        throw new Error("The built-in modeling manifests are unavailable.");
      }
      const hasStage = [...state.components.values()].some((component) => component.type.typeId === "stage-3d");
      const requiredIds = hasStage ? 5 : 6;
      if (state.components.size + requiredIds > MAX_WORKSPACE_COMPONENTS) {
        throw new Error(`The workbench would exceed the ${MAX_WORKSPACE_COMPONENTS}-component workspace limit.`);
      }
      const ids = store.reserveComponentIds(requiredIds);
      let cursor = 0;
      const stageId = hasStage ? undefined : ids[cursor++];
      const assemblyId = ids[cursor++];
      const baseId = ids[cursor++];
      const leftPostId = ids[cursor++];
      const rightPostId = ids[cursor++];
      const beamId = ids[cursor++];
      if (!assemblyId || !baseId || !leftPostId || !rightPostId || !beamId || (!hasStage && !stageId)) {
        throw new Error("The workspace could not reserve the complete model ID set.");
      }
      const existingNodes = buildSemaFrameSpatialGraph(state, { maxNodes: 2_000 }).nodes;
      const rootX = existingNodes.length
        ? Math.max(...existingNodes.map((node) => node.worldBounds.max.x)) + 2
        : 0;
      const world = (x: number, y: number, z: number) => ({
        space: "world3d" as const,
        position: { x, y, z },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
      const operations: WorkspaceOperation[] = [];
      if (stageId) operations.push({
        op: "create_component",
        op_id: uid("op_model_stage"),
        id: stageId,
        component_type: { typeId: stageManifest.typeId, version: stageManifest.version, digest: stageManifest.digest },
        label: "Modeling stage",
        placement: world(0, 0, 0),
      });
      operations.push({
        op: "create_component",
        op_id: uid("op_model_assembly"),
        id: assemblyId,
        component_type: { typeId: assemblyManifest.typeId, version: assemblyManifest.version, digest: assemblyManifest.digest },
        label: "Parametric workbench",
        props: {
          description: "Exact four-part workbench demonstrating assembly, collision, reuse, and solid export.",
          collisionPolicy: "external_only",
        },
        placement: world(rootX, 0, 0),
        tags: ["model", "example", "workbench"],
      });
      const primitive = (
        id: string,
        label: string,
        geometry: JSONObject,
        x: number,
        y: number,
      ): WorkspaceOperation => ({
        op: "create_component",
        op_id: uid("op_model_part"),
        id,
        component_type: { typeId: primitiveManifest.typeId, version: primitiveManifest.version, digest: primitiveManifest.digest },
        label,
        props: { geometry },
        parent_id: assemblyId,
        placement: world(x, y, 0),
        tags: ["model-part", "exact-si"],
      });
      operations.push(
        primitive(baseId, "Workbench base", { kind: "box", sizeM: { x: 3, y: 0.2, z: 1.4 } }, 0, 0.1),
        primitive(leftPostId, "Left post", { kind: "cylinder", radiusM: 0.12, heightM: 1.4, axis: "y" }, -1.25, 0.9),
        primitive(rightPostId, "Right post", { kind: "cylinder", radiusM: 0.12, heightM: 1.4, axis: "y" }, 1.25, 0.9),
        primitive(beamId, "Workbench beam", { kind: "box", sizeM: { x: 3, y: 0.2, z: 1.4 } }, 0, 1.7),
        {
          op: "publish_model",
          op_id: uid("op_publish_example_model"),
          model_id: "com.semaframe.parametric-workbench",
          version: "1.0.0",
          display_name: "Parametric workbench",
          root_id: assemblyId,
        },
      );
      applyWorkspaceOperations(operations, "Created and published the parametric workbench");
      setSelectedComponentId(assemblyId);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, instantiateWorkspaceModel, notice]);

  const exportWorkspaceModel = useCallback((requested: ModelDefinition): boolean => {
    try {
      const state = workspaceStoreRef.current?.getState();
      const key = `${requested.modelId}@${requested.version}`;
      const definition = state?.modelDefinitions.get(key);
      if (!definition || definition.digest !== requested.digest) {
        throw new Error(`${key} is no longer the published model shown in this panel.`);
      }
      const exported = exportParametricModelToUsda(modelDefinitionToOpenUsdDocument(definition));
      downloadUsda(`${definition.modelId}-${definition.version}`, exported.usda);
      notice(`Exported ${definition.displayName} ${definition.version} as deterministic OpenUSD USDA.`, "success");
      return true;
    } catch (error) {
      notice(`Couldn’t export this model: ${friendlyError(error)}`, "error");
      return false;
    }
  }, [notice]);

  const exportWorkspaceModelMesh = useCallback(async (
    requested: ModelDefinition,
    format: "obj" | "stl",
  ): Promise<boolean> => {
    const result = await workspaceModelExportGateRef.current.run(
      `${format.toUpperCase()} export`,
      async () => {
        try {
          const key = `${requested.modelId}@${requested.version}`;
          const definition = workspaceStoreRef.current?.getState().modelDefinitions.get(key);
          if (!definition || definition.digest !== requested.digest) {
            throw new Error(`${key} is no longer the published model shown in this panel.`);
          }
          const exported = await exportModelDefinitionCsgArtifactInWorker(definition, format);
          const stem = `${definition.modelId}-${definition.version}`;
          if (exported.format === "obj") {
            downloadArtifact(stem, "obj", [exported.obj], "text/plain;charset=utf-8");
          } else {
            downloadArtifact(stem, "stl", [binaryBlobPart(exported.stl)], "model/stl");
          }
          notice(
            `Exported ${definition.displayName} as ${format.toUpperCase()} · ${exported.evaluation.mesh.triangleCount.toLocaleString()} triangles · ${exported.evaluation.volumeM3.toPrecision(6)} m³.`,
            "success",
          );
          return true;
        } catch (error) {
          notice(`Couldn’t export this solid: ${friendlyError(error)}`, "error");
          return false;
        }
      },
    );
    if (!result.started) {
      notice(`${result.activeLabel} is already running. Wait for it to finish before starting another solid export.`, "warning");
      return false;
    }
    return result.value;
  }, [notice]);

  const exportWorkspaceModelStep = useCallback(async (requested: ModelDefinition): Promise<boolean> => {
    const result = await workspaceModelExportGateRef.current.run("STEP export", async () => {
      try {
        const key = `${requested.modelId}@${requested.version}`;
        const definition = workspaceStoreRef.current?.getState().modelDefinitions.get(key);
        if (!definition || definition.digest !== requested.digest) {
          throw new Error(`${key} is no longer the published model shown in this panel.`);
        }
        const compatibility = modelDefinitionStepCompatibility(definition);
        if (!compatibility.supported) throw new Error(compatibility.reason ?? "This model is outside the STEP v1 subset.");
        const exported = await exportModelDefinitionToStep(definition);
        downloadArtifact(
          `${definition.modelId}-${definition.version}`,
          "step",
          [exported.step.text],
          exported.step.mimeType,
        );
        notice(
          `Exported ${definition.displayName} as AP242 STEP · ${exported.properties.volumeM3.toPrecision(6)} m³.`,
          "success",
        );
        return true;
      } catch (error) {
        notice(`Couldn’t export STEP: ${friendlyError(error)}`, "error");
        return false;
      }
    });
    if (!result.started) {
      notice(`${result.activeLabel} is already running. Wait for it to finish before starting STEP export.`, "warning");
      return false;
    }
    return result.value;
  }, [notice]);

  const exportWorkspaceModelCadHandoff = useCallback(async (
    requested: ModelDefinition,
  ): Promise<boolean> => {
    const result = await workspaceModelExportGateRef.current.run("CAD handoff export", async () => {
      try {
        const key = `${requested.modelId}@${requested.version}`;
        const definition = workspaceStoreRef.current?.getState().modelDefinitions.get(key);
        if (!definition || definition.digest !== requested.digest) {
          throw new Error(`${key} is no longer the published model shown in this panel.`);
        }
        const compatibility = modelDefinitionCadHandoffCompatibility(definition);
        if (!compatibility.supported) {
          throw new Error(compatibility.reason ?? "This model is outside the exact CAD handoff subset.");
        }
        const exported = await createModelDefinitionCadHandoffPackageInWorker(definition);
        downloadArtifact(
          `${definition.modelId}-${definition.version}`,
          "cad-handoff.zip",
          [binaryBlobPart(exported.archive.bytes)],
          exported.archive.mediaType,
        );
        notice(
          `Exported verified AP242 CAD handoff · ${exported.report.export.partCount} separate solid${exported.report.export.partCount === 1 ? "" : "s"} · OCCT round-trip passed.`,
          "success",
        );
        return true;
      } catch (error) {
        notice(`Couldn’t export CAD handoff: ${friendlyError(error)}`, "error");
        return false;
      }
    });
    if (!result.started) {
      notice(`${result.activeLabel} is already running. Wait for it to finish before starting CAD handoff export.`, "warning");
      return false;
    }
    return result.value;
  }, [notice]);

  const deleteWorkspaceModel = useCallback((requested: ModelDefinition): boolean => {
    try {
      const state = workspaceStoreRef.current?.getState();
      const key = `${requested.modelId}@${requested.version}`;
      const definition = state?.modelDefinitions.get(key);
      if (!definition || definition.digest !== requested.digest) {
        throw new Error(`${key} is no longer the published model shown in this panel.`);
      }
      applyWorkspaceOperations([{
        op: "delete_model_definition",
        op_id: uid("op_delete_model"),
        model: modelDefinitionRef(definition),
        confirm: true,
      }], `Deleted model definition ${key}`);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const updateWorkspaceComponent = useCallback((request: WorkspaceComponentUpdateRequest) => {
    try {
      applyWorkspaceOperations([{
        op: "update_component",
        op_id: uid("op_update"),
        id: request.componentId,
        patch: {
          ...(request.label ? { label: request.label } : {}),
          props: structuredClone(request.props),
        },
      }], `Updated ${request.label || request.componentId}`);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const upgradeWorkspaceComponentManifest = useCallback((componentId: string) => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const component = store.getState().components.get(componentId);
      if (!component) throw new Error(`Component ${componentId} no longer exists.`);
      const current = store.getComponentManifest(component.type.typeId);
      if (!current || current.trustTier !== "builtin") {
        throw new Error(`${component.label} does not have a current built-in manifest upgrade.`);
      }
      applyWorkspaceOperations([{
        op: "upgrade_component_manifest",
        op_id: uid("op_upgrade_manifest"),
        id: component.id,
        component_type: {
          typeId: current.typeId,
          version: current.version,
          digest: current.digest,
        },
      }], `Upgraded ${component.label} interactions to ${current.version}`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const invokeWorkspaceAction = useCallback((request: ComponentActionRequest) => {
    try {
      applyWorkspaceOperations([{
        op: "invoke_component_action",
        op_id: uid("op_action"),
        id: request.componentId,
        action: request.action,
        input: structuredClone((request.input ?? {}) as JSONObject),
      }], `${request.action.replace(/_/gu, " ")} · ${request.componentId}`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const supportsWorkspaceAction = useCallback((
    component: Readonly<ComponentInstance>,
    action: string,
  ) => {
    const manifest = workspaceStoreRef.current?.getComponentManifest(
      component.type.typeId,
      component.type.version,
    );
    return manifest?.digest === component.type.digest && Boolean(manifest.actions[action]);
  }, []);

  const completeDueWorkspaceTimers = useCallback(() => {
    const store = workspaceStoreRef.current;
    if (!store) return;
    const due = planWorkspaceTimerSignals(
      store.getState(),
      supportsWorkspaceAction,
      Date.now(),
    ).due;
    if (!due.length) return;
    try {
      applyWorkspaceSystemOperations(due.map((request) => ({
        op: "invoke_component_action" as const,
        op_id: uid("op_timer_due"),
        id: request.componentId,
        action: request.action,
        input: structuredClone((request.input ?? {}) as JSONObject),
      })));
    } catch (error) {
      notice(`A due timer could not settle: ${friendlyError(error)}`, "warning");
    }
  }, [applyWorkspaceSystemOperations, notice, supportsWorkspaceAction]);

  useEffect(() => {
    const plan = planWorkspaceTimerSignals(workspace, supportsWorkspaceAction, Date.now());
    const wakeAtMs = plan.due.length ? Date.now() : plan.nextDeadlineAtMs;
    if (wakeAtMs === undefined) return;
    const delayMs = Math.min(2_147_483_647, Math.max(0, wakeAtMs - Date.now()));
    const timeout = window.setTimeout(completeDueWorkspaceTimers, delayMs);
    return () => window.clearTimeout(timeout);
  }, [completeDueWorkspaceTimers, supportsWorkspaceAction, workspace]);

  const completeWorkspaceAnimation = useCallback((request: AnimationCompletionRequest) => {
    const store = workspaceStoreRef.current;
    if (!store) return;
    const action = workspaceAnimationCompletionAction(
      store.getState(),
      request,
      supportsWorkspaceAction,
    );
    if (!action) return;
    try {
      applyWorkspaceSystemOperations([{
        op: "invoke_component_action",
        op_id: uid("op_animation_complete"),
        id: action.componentId,
        action: action.action,
        input: structuredClone((action.input ?? {}) as JSONObject),
      }]);
    } catch (error) {
      notice(`Animation completion could not settle: ${friendlyError(error)}`, "warning");
    }
  }, [applyWorkspaceSystemOperations, notice, supportsWorkspaceAction]);

  const activateWorkspaceComponent = useCallback((request: ComponentActivationRequest) => {
    const store = workspaceStoreRef.current;
    const component = store?.getState().components.get(request.componentId);
    if (!store || !component) return;
    const manifest = store.getComponentManifest(component.type.typeId, component.type.version);
    if (!manifest || manifest.digest !== component.type.digest) {
      notice(`The exact component contract for ${component.label} is unavailable.`, "warning");
      return;
    }
    if (!manifest.actions.activate) {
      const current = store.getComponentManifest(component.type.typeId);
      const legacyPinned = current
        && current.version !== component.type.version
        && Boolean(current.actions.activate);
      notice(legacyPinned
        ? `${component.label} uses the older ${component.type.version} interaction contract. Upgrade its component manifest before activating it.`
        : `${component.label} does not expose an activation action.`, "warning");
      return;
    }
    invokeWorkspaceAction({ componentId: request.componentId, action: "activate" });
  }, [invokeWorkspaceAction, notice]);

  const commitWorkspacePlacement = useCallback((request: PlacementCommitRequest) => {
    try {
      applyWorkspaceOperations([{
        op: "place_component",
        op_id: uid("op_place"),
        id: request.componentId,
        placement: structuredClone(request.placement),
      }], `Placed ${request.componentId}`, request.baseRevision);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const workspaceResizePolicy = useCallback((component: WorkspaceRenderComponent) => {
    const manifest = workspaceStoreRef.current?.getComponentManifest(
      component.type.typeId,
      component.type.version,
    );
    return manifest ? resizePolicyForPlacement(manifest, component.placement) : undefined;
  }, []);

  const commitWorkspaceResize = useCallback((
    request: ResizeCommitRequest | WorkspaceComponentResizeRequest,
  ) => {
    try {
      applyWorkspaceOperations(
        resizeCommitOperations(
          request,
          uid("op_resize"),
          uid("op_resize_place"),
        ),
        `Resized ${request.componentId}`,
        "baseRevision" in request ? request.baseRevision : undefined,
      );
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const commitWorkspaceVisualEffects = useCallback((
    request: WorkspaceComponentVisualEffectsRequest,
  ) => {
    try {
      applyWorkspaceOperations([{
        op: "set_component_visual_effects",
        op_id: uid("op_visual_effects"),
        id: request.componentId,
        visual_effects: structuredClone(request.visualEffects),
      }], `Updated visual effects · ${request.componentId}`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const saveWorkspaceInlineSource = useCallback((request: WorkspaceInlineSourceSaveRequest): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const label = request.label.trim();
      if (!label) throw new Error("Give the local snapshot a label.");
      const parsed = parseLocalInlineSource(request.format, request.text);
      const state = store.getState();
      const existing = request.resourceId ? state.resources.get(request.resourceId) : undefined;
      if (request.resourceId && !existing) throw new Error(`Unknown resource ${request.resourceId}.`);
      if (existing && !isCanonicalInlineSnapshotResource(existing)) {
        throw new Error("Only canonical local snapshots can be edited here. Legacy connector records remain read-only.");
      }
      const resourceId = existing?.id ?? uid("RES_local");
      const observedAt = new Date().toISOString();
      const operations: WorkspaceOperation[] = [{
        op: "upsert_resource",
        op_id: uid("op_source"),
        resource: {
          id: resourceId,
          label,
          connectorType: "inline.snapshot",
          connectorVersion: "1.0.0",
          outputSchema: structuredClone(parsed.outputSchema),
          config: {},
          policy: { mode: "manual", offline: "keep_last_good" },
          snapshot: {
            data: structuredClone(parsed.data),
            contentHash: "host-computed",
            retrievedAt: observedAt,
            stale: false,
            provenance: [],
          },
          status: "ready",
        },
      }];

      if (request.targetComponentId) {
        const component = state.components.get(request.targetComponentId);
        if (!component) throw new Error(`Unknown component ${request.targetComponentId}.`);
        const manifest = store.getComponentManifest(component.type.typeId, component.type.version);
        if (!manifest || manifest.digest !== component.type.digest) {
          throw new Error(`The exact component contract for ${component.id} is unavailable.`);
        }
        const desiredBindings = manifest.typeId === "chart"
          ? parsed.kind === "chart_timeseries"
            ? [
              { targetProp: "labels", sourcePath: "$.labels" },
              { targetProp: "series", sourcePath: "$.series" },
            ]
            : (() => { throw new Error("Chart targets require normalized { labels, series } JSON or CSV."); })()
          : request.targetProp
            ? [{ targetProp: request.targetProp, sourcePath: request.sourcePath?.trim() || "$" }]
            : (() => { throw new Error("Choose a writable target property."); })();

        for (const desired of desiredBindings) {
          for (const connection of state.connections.values()) {
            if (connection.kind === "resource_binding"
              && connection.componentId === component.id
              && connection.targetProp === desired.targetProp) {
              operations.push({
                op: "unbind_resource",
                op_id: uid("op_unbind_source"),
                binding_id: connection.id,
              });
            }
          }
          operations.push({
            op: "bind_resource",
            op_id: uid("op_bind_source"),
            binding: {
              kind: "resource_binding",
              id: uid("BIND_local"),
              resourceId,
              componentId: component.id,
              targetProp: desired.targetProp,
              sourcePath: desired.sourcePath,
              mode: "snapshot",
              transform: { kind: "identity" },
              enabled: true,
            },
          });
        }
      }

      applyWorkspaceOperations(operations, `${existing ? "Updated" : "Added"} ${label}`);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, notice]);

  const reapplyWorkspaceSource = useCallback((resourceId: string) => {
    try {
      const resource = workspaceStoreRef.current?.getState().resources.get(resourceId);
      if (!resource) throw new Error(`Unknown resource ${resourceId}.`);
      if (!isCanonicalInlineSnapshotResource(resource)) {
        throw new Error("This connector has no trusted local refresh runtime. Legacy sources are preserved read-only.");
      }
      applyWorkspaceOperations([{
        op: "upsert_resource",
        op_id: uid("op_reapply_source"),
        resource: structuredClone(resource),
      }], `Reapplied ${resource.label}`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const cancelWorkspaceHostFeedRefresh = useCallback((resourceId: string) => {
    hostFeedRefreshControllersRef.current.get(resourceId)?.abort();
    hostFeedRefreshControllersRef.current.delete(resourceId);
    hostFeedRefreshInFlightRef.current.delete(resourceId);
    setHostFeedRuntime((current) => {
      if (!(resourceId in current)) return current;
      const next = { ...current };
      delete next[resourceId];
      return next;
    });
  }, []);

  useEffect(() => {
    const resourceIds = new Set(workspace.resources.keys());
    for (const [resourceId, controller] of hostFeedRefreshControllersRef.current) {
      if (resourceIds.has(resourceId)) continue;
      controller.abort();
      hostFeedRefreshControllersRef.current.delete(resourceId);
      hostFeedRefreshInFlightRef.current.delete(resourceId);
    }
    setHostFeedRuntime((current) => {
      const staleIds = Object.keys(current).filter((resourceId) => !resourceIds.has(resourceId));
      if (!staleIds.length) return current;
      const next = { ...current };
      for (const resourceId of staleIds) delete next[resourceId];
      return next;
    });
  }, [workspace]);

  const fetchWorkspaceHostFeed = useCallback(async (
    request: HostFeedFetchRequest,
    signal?: AbortSignal,
  ): Promise<HostFeedFetchResponse> => {
    const client = agentGatewayRef.current;
    if (!client) throw new Error("The local feed broker is still starting. Try again in a moment.");
    return client.fetchHostFeed(request, signal);
  }, []);

  const previewWorkspaceHostFeed = useCallback(async (request: WorkspaceHostFeedPreviewRequest) => {
    const generation = workspaceGenerationRef.current;
    const controller = new AbortController();
    hostFeedPreviewControllersRef.current.add(controller);
    try {
      const result = await fetchWorkspaceHostFeed({
        url: request.url,
        format: request.format,
      }, controller.signal);
      if (controller.signal.aborted || generation !== workspaceGenerationRef.current) {
        throw new DOMException("Workspace feed preview was cancelled", "AbortError");
      }
      hostFeedAutomationConsentRef.current.recordPreview(request, result);
      return result;
    } finally {
      hostFeedPreviewControllersRef.current.delete(controller);
    }
  }, [fetchWorkspaceHostFeed]);

  const saveWorkspaceHostFeed = useCallback(async (
    request: WorkspaceHostFeedSaveRequest,
  ): Promise<boolean> => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const label = request.label.trim();
      if (!label) throw new Error("Give the feed a label.");
      const state = store.getState();
      const existing = request.resourceId ? state.resources.get(request.resourceId) : undefined;
      if (request.resourceId && (!existing || !isCanonicalHostFeedResource(existing))) {
        throw new Error(`Unknown trusted host feed ${request.resourceId}.`);
      }
      if (!hostFeedAutomationConsentRef.current.matchesPreview(request)) {
        throw new Error("Preview this exact feed URL, format, and refresh policy again before saving.");
      }
      const resourceId = request.resourceId ?? uid("RES_feed");
      const operations: WorkspaceOperation[] = [{
        op: "upsert_resource",
        op_id: uid("op_feed"),
        resource: {
          id: resourceId,
          label,
          connectorType: HOST_FEED_CONNECTOR_TYPE,
          connectorVersion: HOST_FEED_CONNECTOR_VERSION,
          outputSchema: structuredClone(request.feed.outputSchema),
          config: {
            url: request.feed.requestedUrl,
            format: request.requestedFormat,
          },
          policy: structuredClone(request.policy),
          snapshot: structuredClone(request.feed.snapshot),
          status: "ready",
        },
      }];

      if (request.targetComponentId) {
        const component = state.components.get(request.targetComponentId);
        if (!component) throw new Error(`Unknown component ${request.targetComponentId}.`);
        const manifest = store.getComponentManifest(component.type.typeId, component.type.version);
        if (!manifest || manifest.digest !== component.type.digest) {
          throw new Error(`The exact component contract for ${component.id} is unavailable.`);
        }
        if (!request.mapping || request.mapping.targetType !== manifest.typeId) {
          throw new Error("Choose a feed mapping that matches the selected component.");
        }
        if (request.mapping.initialProps && Object.keys(request.mapping.initialProps).length) {
          operations.push({
            op: "update_component",
            op_id: uid("op_feed_props"),
            id: component.id,
            patch: { props: structuredClone(request.mapping.initialProps) },
          });
        }
        for (const desired of request.mapping.bindings) {
          if (!manifest.writableProps.includes(desired.targetProp)) {
            throw new Error(`${manifest.displayName}.${desired.targetProp} is not writable.`);
          }
          for (const connection of state.connections.values()) {
            if (connection.kind === "resource_binding"
              && connection.componentId === component.id
              && connection.targetProp === desired.targetProp) {
              operations.push({
                op: "unbind_resource",
                op_id: uid("op_unbind_feed"),
                binding_id: connection.id,
              });
            }
          }
          operations.push({
            op: "bind_resource",
            op_id: uid("op_bind_feed"),
            binding: {
              kind: "resource_binding",
              id: uid("BIND_feed"),
              resourceId,
              componentId: component.id,
              targetProp: desired.targetProp,
              sourcePath: desired.sourcePath,
              mode: "snapshot",
              transform: structuredClone(desired.transform),
              enabled: true,
            },
          });
        }
      }

      cancelWorkspaceHostFeedRefresh(resourceId);
      applyWorkspaceOperations(operations, `${existing ? "Updated" : "Connected"} ${label}`);
      if (!hostFeedAutomationConsentRef.current.authorizePreviewedSave(resourceId, request)) {
        throw new Error("Feed automation approval expired before the update completed. Preview it again.");
      }
      setHostFeedAutomationRevision((current) => current + 1);
      hostFeedOnOpenSeenRef.current.add(`${workspaceGenerationRef.current}:${state.workspaceId}:${resourceId}`);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, cancelWorkspaceHostFeedRefresh, notice]);

  const commitWorkspaceSourceWithNewTarget = useCallback((
    request: WorkspaceSourceAtomicCreateRequest,
  ): boolean => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const state = store.getState();
      const generation = workspaceGenerationRef.current;
      const manifest = store.getComponentManifest(request.destination.componentType);
      if (!manifest) throw new Error(`Unknown component type ${request.destination.componentType}.`);
      const nextSequence = store.getAllocatorSnapshot();
      if (!Number.isSafeInteger(nextSequence) || nextSequence < 1 || nextSequence > 999_999) {
        throw new Error("The workspace cannot allocate another component ID.");
      }
      const componentId = `CMP_${String(nextSequence).padStart(6, "0")}`;
      const resourceId = request.source.resourceId
        ?? uid(request.kind === "local" ? "RES_local" : "RES_feed");
      if (request.kind === "https"
        && !hostFeedAutomationConsentRef.current.matchesPreview(request.source)) {
        throw new Error("Preview this exact feed URL, format, and refresh policy again before saving.");
      }
      const plan = planWorkspaceSourceAtomicCreate({
        request,
        state,
        manifest,
        placement: defaultWorkspacePlacement(manifest, state.components.size, state),
        componentId,
        resourceId,
        observedAt: new Date().toISOString(),
        id: (purpose, index) => uid(`op_source_${purpose}${index === undefined ? "" : `_${index + 1}`}`),
      });
      if (generation !== workspaceGenerationRef.current) {
        throw new Error("The project changed while the source destination was being prepared.");
      }
      applyWorkspaceOperations(
        [...plan.operations],
        `Connected ${request.source.label.trim()} to ${request.destination.componentLabel.trim()}`,
        plan.baseRevision,
      );
      if (request.kind === "https") {
        if (!hostFeedAutomationConsentRef.current.authorizePreviewedSave(resourceId, request.source)) {
          throw new Error("Feed approval expired while the atomic update was committing.");
        }
        cancelWorkspaceHostFeedRefresh(resourceId);
        setHostFeedAutomationRevision((current) => current + 1);
        hostFeedOnOpenSeenRef.current.add(`${generation}:${state.workspaceId}:${resourceId}`);
      }
      setSelectedComponentId(componentId);
      return true;
    } catch (error) {
      notice(friendlyError(error), "error");
      return false;
    }
  }, [applyWorkspaceOperations, cancelWorkspaceHostFeedRefresh, notice]);

  const unbindWorkspaceSource = useCallback((bindingId: string) => {
    try {
      const connection = workspaceStoreRef.current?.getState().connections.get(bindingId);
      if (!connection || connection.kind !== "resource_binding") {
        throw new Error(`Unknown source binding ${bindingId}.`);
      }
      applyWorkspaceOperations([{
        op: "unbind_resource",
        op_id: uid("op_unbind_source"),
        binding_id: bindingId,
      }], "Removed source binding");
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const deleteWorkspaceSource = useCallback((resourceId: string) => {
    try {
      const resource = workspaceStoreRef.current?.getState().resources.get(resourceId);
      if (!resource) throw new Error(`Unknown resource ${resourceId}.`);
      cancelWorkspaceHostFeedRefresh(resourceId);
      applyWorkspaceOperations([{
        op: "delete_resource",
        op_id: uid("op_delete_source"),
        resource_id: resourceId,
        cascade: true,
      }], `Deleted ${resource.label}`);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, cancelWorkspaceHostFeedRefresh, notice]);

  const refreshWorkspaceHostFeed = useCallback(async (
    resourceId: string,
    reason: "manual" | "interval" | "on_open" = "manual",
    expectedGeneration = workspaceGenerationRef.current,
  ): Promise<void> => {
    if (expectedGeneration !== workspaceGenerationRef.current) return;
    if (hostFeedRefreshInFlightRef.current.has(resourceId)) return;
    const before = workspaceStoreRef.current?.getState().resources.get(resourceId);
    if (!before) {
      notice(`Unknown resource ${resourceId}.`, "error");
      return;
    }
    if (before.connectorType !== HOST_FEED_CONNECTOR_TYPE
      || before.connectorVersion !== HOST_FEED_CONNECTOR_VERSION) {
      reapplyWorkspaceSource(resourceId);
      return;
    }
    const automationDescriptor = hostFeedAutomationDescriptor(before);
    if (!automationDescriptor
      || !hostFeedRefreshAllowed(
        reason,
        automationDescriptor,
        hostFeedAutomationConsentRef.current,
      )) return;
    const url = typeof before.config.url === "string" ? before.config.url : undefined;
    const format = before.config.format;
    if (!url || (format !== "auto" && format !== "json" && format !== "csv" && format !== "rss")) {
      notice(`Feed ${before.label} has invalid host configuration.`, "error");
      return;
    }

    const storeAtStart = workspaceStoreRef.current;
    if (!storeAtStart) return;
    const workspaceIdAtStart = storeAtStart.getState().workspaceId;
    const controller = new AbortController();
    hostFeedRefreshControllersRef.current.set(resourceId, controller);
    hostFeedRefreshInFlightRef.current.add(resourceId);
    setHostFeedRuntime((current) => ({
      ...current,
      [resourceId]: {
        ...current[resourceId],
        refreshing: true,
        error: undefined,
        nextRetryAt: undefined,
      },
    }));
    try {
      const feed = await fetchWorkspaceHostFeed({ url, format }, controller.signal);
      if (controller.signal.aborted
        || expectedGeneration !== workspaceGenerationRef.current
        || workspaceStoreRef.current !== storeAtStart) return;
      const store = workspaceStoreRef.current;
      const current = store?.getState().resources.get(resourceId);
      if (!store || store.getState().workspaceId !== workspaceIdAtStart
        || !current || current.connectorType !== HOST_FEED_CONNECTOR_TYPE
        || current.connectorVersion !== HOST_FEED_CONNECTOR_VERSION
        || current.config.url !== url || current.config.format !== format) return;
      applyWorkspaceSystemOperations([{
        op: "upsert_resource",
        op_id: uid("op_refresh_feed"),
        resource: {
          ...structuredClone(current),
          outputSchema: structuredClone(feed.outputSchema),
          snapshot: structuredClone(feed.snapshot),
          status: "ready",
          lastError: undefined,
        },
      }]);
      setHostFeedRuntime((runtime) => ({
        ...runtime,
        [resourceId]: { refreshing: false, failureCount: 0 },
      }));
      if (reason === "manual") {
        notice(`Refreshed ${current.label}; bound panels now show the latest snapshot.`, "success");
      }
    } catch (error) {
      if (controller.signal.aborted || expectedGeneration !== workspaceGenerationRef.current) return;
      const message = friendlyError(error);
      // Failure is intentionally ephemeral: the durable last-good snapshot and
      // deterministic project history remain unchanged. Interval feeds retain
      // an explicit retry deadline so one transient failure cannot stop them.
      setHostFeedRuntime((current) => {
        const failureCount = (current[resourceId]?.failureCount ?? 0) + 1;
        const intervalMs = before.policy.mode === "interval" ? before.policy.intervalMs : undefined;
        return {
          ...current,
          [resourceId]: {
            refreshing: false,
            error: message,
            failureCount,
            ...(intervalMs ? {
              nextRetryAt: Date.now() + hostFeedRetryDelayMs(intervalMs, failureCount),
            } : {}),
          },
        };
      });
      if (reason !== "interval") {
        notice(`Feed refresh failed; the last good snapshot is still shown. ${message}`, "warning");
      }
    } finally {
      if (hostFeedRefreshControllersRef.current.get(resourceId) === controller) {
        hostFeedRefreshControllersRef.current.delete(resourceId);
        hostFeedRefreshInFlightRef.current.delete(resourceId);
        if (expectedGeneration === workspaceGenerationRef.current && !controller.signal.aborted) {
          setHostFeedRuntime((current) => {
            const runtime = current[resourceId];
            return runtime?.refreshing
              ? { ...current, [resourceId]: { ...runtime, refreshing: false } }
              : current;
          });
        }
      }
    }
  }, [applyWorkspaceSystemOperations, fetchWorkspaceHostFeed, notice, reapplyWorkspaceSource]);

  useEffect(() => {
    const timers: number[] = [];
    const now = Date.now();
    const generation = workspaceRenderGeneration;
    for (const resource of workspace.resources.values()) {
      const automationDescriptor = hostFeedAutomationDescriptor(resource);
      if (!automationDescriptor
        || hostFeedAutomationPaused(automationDescriptor, hostFeedAutomationConsentRef.current)) continue;
      const openKey = `${generation}:${workspace.workspaceId}:${resource.id}`;
      if (resource.policy.mode === "on_open" && !hostFeedOnOpenSeenRef.current.has(openKey)) {
        hostFeedOnOpenSeenRef.current.add(openKey);
        void refreshWorkspaceHostFeed(resource.id, "on_open", generation);
        continue;
      }
      if (resource.policy.mode !== "interval" || !resource.policy.intervalMs) continue;
      const runtime = hostFeedRuntime[resource.id];
      if (runtime?.refreshing) continue;
      const delay = nextHostFeedRefreshDelayMs({
        now,
        intervalMs: resource.policy.intervalMs,
        retrievedAt: resource.snapshot?.retrievedAt,
        nextRetryAt: runtime?.nextRetryAt,
      });
      timers.push(window.setTimeout(
        () => void refreshWorkspaceHostFeed(resource.id, "interval", generation),
        delay,
      ));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hostFeedAutomationRevision, hostFeedRuntime, refreshWorkspaceHostFeed, workspace, workspaceRenderGeneration]);

  const createMixedWorkspaceShowcase = useCallback(() => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const stage = store.getComponentManifest("stage-3d");
      const spatial = store.getComponentManifest("spatial-entity");
      const timer = store.getComponentManifest("timer");
      if (!stage || !spatial || !timer) throw new Error("The built-in mixed workspace components are unavailable.");
      const hasStage = [...store.getState().components.values()].some(
        (component) => component.type.typeId === "stage-3d",
      );
      const reserved = store.reserveComponentIds(hasStage ? 3 : 4);
      const [stageId, deskId, personId, timerId] = hasStage
        ? [undefined, ...reserved]
        : reserved;
      if (!deskId || !personId || !timerId) throw new Error("The workspace could not reserve component IDs.");
      const operations: WorkspaceOperation[] = [];
      if (!hasStage) {
        if (!stageId) throw new Error("The workspace could not reserve a 3D stage ID.");
        operations.push({
          op: "create_component", op_id: uid("op_stage"), id: stageId,
          component_type: { typeId: stage.typeId, version: stage.version, digest: stage.digest },
          label: "3D Stage",
          placement: { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          tags: ["showcase", "stage"],
        });
      }
      operations.push(
        {
          op: "create_component", op_id: uid("op_desk"), id: deskId,
          component_type: { typeId: spatial.typeId, version: spatial.version, digest: spatial.digest },
          label: "Work desk",
          props: { assetId: "table_wood_simple_01", entityKind: "prop", appearance: {}, state: {} },
          placement: { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          tags: ["showcase", "desk"],
        },
        {
          op: "create_component", op_id: uid("op_person"), id: personId,
          component_type: { typeId: spatial.typeId, version: spatial.version, digest: spatial.digest },
          label: "Presenter",
          props: { assetId: "humanoid_adult_neutral_01", entityKind: "character", appearance: {}, state: { type: "character", pose: "standing" } },
          placement: { space: "world3d", position: { x: 1.5, y: 0, z: .25 }, rotation: { x: 0, y: -1.3, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          tags: ["showcase", "presenter"],
        },
        {
          op: "create_component", op_id: uid("op_timer"), id: timerId,
          component_type: { typeId: timer.typeId, version: timer.version, digest: timer.digest },
          label: "Presentation timer",
          props: { durationMs: 300_000, label: "Presentation", format: "clock", showProgress: true },
          placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 58 }, size: { width: 300, height: 160 }, zIndex: 50 },
          tags: ["showcase", "timer"],
        },
      );
      applyWorkspaceOperations(operations, "Added a 3D desk, presenter, and working 2D timer");
      setSelectedComponentId(timerId);
      window.setTimeout(() => hybridCanvasRef.current?.frameAll(), 80);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);

  const agentHostControl = useMemo(() => new AgentHostControlCoordinator({
    workspaceId: () => workspaceStoreRef.current?.getState().workspaceId ?? "",
    inspectVoiceRelay: async () => {
      const status = await voiceRelayClientRef.current!.inspect();
      return {
        command: "inspect_voice_relay",
        phase: status.phase,
        message: status.armed
          ? `Voice Relay is armed for ${status.target?.label ?? "the configured Agent"}.`
          : status.target
            ? `Voice Relay is configured for ${status.target.label} and awaits user arm.`
            : "Voice Relay is off or needs configuration.",
        status: publicVoiceRelayStatus(status),
      };
    },
    prepareVoiceRelaySetup: async (input) => {
      const client = voiceRelayClientRef.current!;
      const setup = await client.prepareSetup();
      setVoiceRelayPreparation(setup);
      setVoiceRelayStatus(await client.inspect());
      if (setup.accessibility !== "authorized") {
        const action = presentHostAction({
          kind: "grant_accessibility",
          label: "Grant Accessibility permission for Voice Relay",
          dedupeKey: "voice-relay:accessibility",
          title: "Allow Voice Relay accessibility",
          message: "The local helper needs operating-system Accessibility permission to write only to the Agent window you confirm. SemaFrame cannot grant this permission for you.",
          confirmLabel: "Open permission flow",
          confirm: async () => {
            const next = await runConfirmedVoiceRelayHostAction(
              "voice_relay_accessibility",
              () => client.requestAccessibility(),
            );
            setVoiceRelayPreparation(next);
            setVoiceRelayStatus(await client.inspect());
          },
        });
        return {
          command: "prepare_voice_relay_setup",
          phase: "awaiting_user_confirmation",
          message: "Accessibility permission is required before SemaFrame can detect a compatible Agent composer.",
          required_user_action: action,
        };
      }
      if (setup.configuredTarget) {
        return {
          command: "prepare_voice_relay_setup",
          phase: "ready",
          message: `Voice Relay target ${setup.configuredTarget.label} is configured and awaits user arm.`,
          target: {
            label: setup.configuredTarget.label,
            capabilities: setup.configuredTarget.capabilities,
          },
        };
      }
      const candidate = recommendedVoiceRelayCandidate(setup.candidates, [
        typeof input.target_hint === "string" ? input.target_hint : undefined,
        agentGatewayRef.current?.config?.clientName,
      ]);
      if (!candidate) {
        setVoiceRelaySettingsOpen(true);
        return {
          command: "prepare_voice_relay_setup",
          phase: "needs_configuration",
          message: setup.candidates.some((entry) => entry.compatible)
            ? "More than one compatible Agent window is available. The user must choose the exact target in SemaFrame."
            : "No compatible accessible Agent window was found.",
          capabilities: {
            compatible_target_count: setup.candidates.filter((entry) => entry.compatible).length,
          },
        };
      }
      const action = presentHostAction({
        kind: "confirm_target",
        label: `Use ${candidate.label} as the Voice Relay target`,
        dedupeKey: `voice-relay:target:${candidate.candidateId}`,
        title: "Confirm the Voice Relay target",
        message: "SemaFrame will bind only the displayed Agent window and its verified input, Send, and reply controls. The Agent cannot change this target.",
        targetLabel: `${candidate.applicationLabel} · ${candidate.label}`,
        confirmLabel: "Use this Agent window",
        confirm: async () => {
          await runConfirmedVoiceRelayHostAction(
            "voice_relay_configure_target",
            () => client.configureTarget({ candidateId: candidate.candidateId }),
          );
          setVoiceRelayPreparation(await client.prepareSetup());
          setVoiceRelayStatus(await client.inspect());
          setVoiceRelayDiagnostics(await client.runDiagnostics());
        },
      });
      return {
        command: "prepare_voice_relay_setup",
        phase: "awaiting_user_confirmation",
        message: `A compatible target was found: ${candidate.label}.`,
        recommended_target: `${candidate.applicationLabel} · ${candidate.label}`,
        required_user_action: action,
      };
    },
    runVoiceRelayDiagnostics: async (input) => {
      const client = voiceRelayClientRef.current!;
      if (input.include_safe_input_test === true) {
        const current = await client.inspect();
        const targetLabel = current.target?.label;
        if (!targetLabel) throw new AgentHostControlError("target_unconfigured", "Configure a Voice Relay target first.");
        const action = presentHostAction({
          kind: "confirm_safe_test",
          label: `Run a non-sending test in ${targetLabel}`,
          dedupeKey: `voice-relay:diagnostics:${targetLabel}`,
          title: "Test the configured Agent composer",
          message: "SemaFrame will require an empty composer, insert a random nonce, read it back exactly, and remove it. It will not press Send.",
          targetLabel,
          confirmLabel: "Run safe test",
          confirm: async () => {
            await runConfirmedVoiceRelayHostAction(
              "voice_relay_draft_round_trip",
              () => client.runDiagnostics({ performDraftRoundTrip: true }),
            );
          },
        });
        return {
          command: "run_voice_relay_diagnostics",
          phase: "awaiting_user_confirmation",
          message: "The no-send composer test awaits user confirmation.",
          required_user_action: action,
        };
      }
      const report = await client.runDiagnostics();
      setVoiceRelayDiagnostics(report);
      return {
        command: "run_voice_relay_diagnostics",
        phase: report.ready ? "ready" : "needs_configuration",
        message: report.ready ? "Voice Relay diagnostics passed." : "Voice Relay needs attention.",
        report,
      };
    },
    requestVoiceRelayArm: async () => {
      const client = voiceRelayClientRef.current!;
      const current = await client.inspect();
      if (!current.target) throw new AgentHostControlError("target_unconfigured", "Configure a Voice Relay target first.");
      if (current.armed) {
        return {
          command: "request_voice_relay_arm",
          phase: "armed",
          message: `Voice Relay is already armed for ${current.target.label}.`,
        };
      }
      const action = presentHostAction({
        kind: "arm_voice_relay",
        label: `Arm Voice Relay for ${current.target.label}`,
        dedupeKey: `voice-relay:arm:${current.target.targetId}`,
        title: "Arm Voice Relay for this session",
        message: "While armed, VR speech can be staged into this exact Agent composer. Every message still requires a separate confirmation inside VR.",
        targetLabel: current.target.label,
        confirmLabel: "Arm Voice Relay",
        confirm: async () => {
          await runConfirmedVoiceRelayHostAction(
            "voice_relay_arm",
            async () => {
              const result = await client.requestArm(current.target!.targetId);
              setVoiceRelayStatus(result.status);
              return result;
            },
          );
        },
      });
      return {
        command: "request_voice_relay_arm",
        phase: "awaiting_user_confirmation",
        message: `Voice Relay arm was requested for ${current.target.label}.`,
        required_user_action: action,
      };
    },
    inspectXrReadiness: async () => {
      const same = sameDeviceXrStateRef.current;
      const headset = headsetXrStateRef.current;
      const remote = headsetXrControlRef.current?.inspect();
      return {
        command: "inspect_xr_readiness",
        phase: xrHostPhase(same.phase, headset.phase),
        message: same.phase === "ready" || same.phase === "active"
          ? same.message
          : headset.message,
        capabilities: {
          same_device_webxr: same.phase !== "unsupported" && same.phase !== "error",
          same_device_phase: same.phase,
          remote_headset_phase: headset.phase,
          remote_lifecycle_sequence: remote?.lifecycleSequence ?? 0,
          remote_last_lifecycle_phase: remote?.lastLifecyclePhase ?? null,
          render_profile: sameDeviceXrControlRef.current?.inspect().renderProfile ?? "balanced",
        },
      };
    },
    prepareXrSession: async (input) => {
      const relayRequested = input.voice_relay === "if_configured";
      const relayStatus = relayRequested
        ? await voiceRelayClientRef.current!.inspect().catch(() => undefined)
        : undefined;
      const relayPairingAllowed = Boolean(
        relayStatus?.enabled && relayStatus.armed && relayStatus.target,
      );
      const requestedMode = input.mode === "remote_headset" ? "remote_headset"
        : input.mode === "same_device" ? "same_device"
          : relayPairingAllowed
            ? "remote_headset"
          : sameDeviceXrStateRef.current.phase === "ready" || sameDeviceXrStateRef.current.phase === "active"
            ? "same_device"
            : "remote_headset";
      if (requestedMode === "same_device") {
        preparedXrModeRef.current = "same_device";
        await headsetXrControlRef.current?.setVoiceRelayEnabled(false);
        const same = sameDeviceXrControlRef.current?.inspect();
        if (!same || same.phase === "unsupported") {
          throw new AgentHostControlError("xr_unavailable", "Immersive WebXR is unavailable in this browser.");
        }
        if (input.render_profile === "validated_ultra" && same.renderProfile !== "ultra") {
          throw new AgentHostControlError(
            "ultra_not_validated",
            "Windows Ultra can be selected only after the local physical benchmark passes.",
          );
        }
        if (same.phase === "active") {
          return {
            command: "prepare_xr_session",
            phase: "active",
            message: "Immersive XR is already active.",
            capabilities: {
              mode: "same_device",
              voice_relay_in_immersive: false,
              voice_input: relayRequested
                ? "Use the paired headset viewer for optional Voice Relay, or use a voice-capable Agent on the computer microphone."
                : "Voice Relay is off; a voice-capable Agent may use the computer microphone directly.",
            },
          };
        }
        const action = presentHostAction({
          kind: "enter_immersive_xr",
          label: "Enter immersive XR",
          dedupeKey: "xr:enter:same-device",
          title: "Everything is ready for VR",
          message: "The Agent prepared the current Workspace. Your click is required by WebXR before the headset display and sensors can start.",
          confirmLabel: "Enter XR",
          confirm: () => sameDeviceXrControlRef.current?.enterFromUserGesture(),
        });
        return {
          command: "prepare_xr_session",
          phase: "awaiting_user_gesture",
          message: relayRequested
            ? "The Workspace is ready. Same-device XR keeps Voice Relay off; use remote_headset for in-headset push-to-talk, or let a voice-capable Agent use the computer microphone."
            : "The Workspace is ready; one trusted user gesture is required to enter immersive XR.",
          required_user_action: action,
          capabilities: {
            mode: "same_device",
            render_profile: same.renderProfile,
            voice_relay_in_immersive: false,
            microphone_permission: "not_requested_by_semaframe",
          },
        };
      }
      preparedXrModeRef.current = "remote_headset";
      await headsetXrControlRef.current?.setVoiceRelayEnabled(relayPairingAllowed);
      const prepared = await headsetXrControlRef.current?.prepare();
      if (!prepared?.pairingReady) {
        throw new AgentHostControlError("headset_projection_failed", prepared?.message ?? "The headset projection is unavailable.");
      }
      xrAgentLifecycleCursorRef.current = prepared.lifecycleSequence;
      const action = presentHostAction({
        kind: "open_headset_link",
        label: "Open the one-time viewer in the headset",
        dedupeKey: "xr:open:remote-headset",
        title: "Open SemaFrame in your headset",
        message: "The authoritative projection and assets are ready. Open the displayed one-time link in the headset, then press Enter XR there.",
        confirmLabel: "Show pairing link",
        confirm: () => headsetXrControlRef.current?.showPairing(),
      });
      return {
        command: "prepare_xr_session",
        phase: "pairing",
        message: relayPairingAllowed
          ? "The remote headset projection is prepared with optional Voice Relay. The headset browser requests microphone permission only after the user's first push-to-talk gesture."
          : relayRequested
            ? "The remote headset projection is prepared, but Voice Relay was not configured and remains unavailable for this pairing."
            : "The remote headset projection is prepared with Voice Relay disabled and without exposing its one-time pairing secret to the Agent.",
        required_user_action: action,
        capabilities: {
          mode: "remote_headset",
          voice_relay_pairing_enabled: relayPairingAllowed,
          voice_relay_armed: relayStatus?.armed === true,
          microphone_permission: relayPairingAllowed ? "requested_on_first_user_ptt" : "not_requested",
          requested_render_profile: input.render_profile === "validated_ultra" ? "validated_ultra" : "balanced",
          render_profile_status: input.render_profile === "validated_ultra"
            ? "requires_headset_user_benchmark"
            : "balanced",
          lifecycle_sequence: prepared.lifecycleSequence,
        },
      };
    },
    requestEnterXr: async () => {
      if (preparedXrModeRef.current === "remote_headset") {
        const remote = headsetXrStateRef.current;
        const lifecycleSequence = headsetXrControlRef.current?.inspect().lifecycleSequence ?? 0;
        xrAgentLifecycleCursorRef.current = lifecycleSequence;
        if (remote.phase === "active") {
          return {
            command: "request_enter_xr",
            phase: "active",
            message: "The paired headset is already in immersive XR.",
            capabilities: { lifecycle_sequence: lifecycleSequence },
          };
        }
        headsetXrControlRef.current?.showPairing();
        return {
          command: "request_enter_xr",
          phase: "awaiting_user_gesture",
          message: "Open the prepared one-time viewer and press Enter XR in the headset. SemaFrame cannot synthesize that trusted WebXR gesture.",
          capabilities: { lifecycle_sequence: lifecycleSequence },
        };
      }
      const same = sameDeviceXrControlRef.current?.inspect();
      if (same?.phase === "active") {
        return { command: "request_enter_xr", phase: "active", message: "Immersive XR is already active." };
      }
      if (same?.phase === "ready") {
        const action = presentHostAction({
          kind: "enter_immersive_xr",
          label: "Enter immersive XR",
          dedupeKey: "xr:enter:same-device",
          title: "Enter VR",
          message: "The Agent completed preparation. WebXR requires your click to begin the immersive session.",
          confirmLabel: "Enter XR",
          confirm: () => sameDeviceXrControlRef.current?.enterFromUserGesture(),
        });
        return {
          command: "request_enter_xr",
          phase: "awaiting_user_gesture",
          message: "Press Enter XR to continue.",
          required_user_action: action,
        };
      }
      headsetXrControlRef.current?.showPairing();
      return {
        command: "request_enter_xr",
        phase: "awaiting_user_gesture",
        message: "Press Enter XR in the paired headset browser.",
      };
    },
    waitForXrSessionState: async (input, context) => {
      const waitMs = typeof input.wait_ms === "number" && Number.isSafeInteger(input.wait_ms)
        ? Math.max(0, Math.min(25_000, input.wait_ms))
        : 20_000;
      if (preparedXrModeRef.current === "remote_headset") {
        const explicitCursor = typeof input.after_sequence === "number"
          && Number.isSafeInteger(input.after_sequence)
          && input.after_sequence >= 0
          ? input.after_sequence
          : undefined;
        const cursor = explicitCursor ?? xrAgentLifecycleCursorRef.current;
        const deadline = Date.now() + waitMs;
        do {
          const transition = headsetXrControlRef.current?.readLifecycleTransition(cursor);
          if (transition) {
            xrAgentLifecycleCursorRef.current = transition.sequence;
            return {
              command: "wait_for_xr_session_state",
              phase: transition.phase,
              message: "The paired headset reported the next authenticated XR lifecycle transition.",
              capabilities: {
                lifecycle_sequence: transition.sequence,
                server_received_at_ms: transition.serverReceivedAtMs,
              },
            };
          }
          if (Date.now() >= deadline) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        } while (!context.signal.aborted);
        if (context.signal.aborted) throw context.signal.reason ?? new DOMException("Cancelled", "AbortError");
        const inspected = headsetXrControlRef.current?.inspect();
        return {
          command: "wait_for_xr_session_state",
          phase: headsetXrStateRef.current.phase,
          message: "No paired-headset lifecycle transition occurred after the requested sequence before the wait expired.",
          capabilities: { lifecycle_sequence: inspected?.lifecycleSequence ?? cursor },
        };
      }
      const initial = xrHostPhase(sameDeviceXrStateRef.current.phase, headsetXrStateRef.current.phase);
      const deadline = Date.now() + waitMs;
      while (!context.signal.aborted && Date.now() < deadline) {
        const next = xrHostPhase(sameDeviceXrStateRef.current.phase, headsetXrStateRef.current.phase);
        if (next !== initial || next === "active" || next === "error") {
          return { command: "wait_for_xr_session_state", phase: next, message: "XR lifecycle changed." };
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      if (context.signal.aborted) throw context.signal.reason ?? new DOMException("Cancelled", "AbortError");
      return { command: "wait_for_xr_session_state", phase: initial, message: "No XR lifecycle change occurred before the wait expired." };
    },
    requestExitXr: async () => {
      if (preparedXrModeRef.current === "remote_headset"
        || headsetXrStateRef.current.phase === "active") {
        const lifecycleSequence = headsetXrControlRef.current?.inspect().lifecycleSequence ?? 0;
        xrAgentLifecycleCursorRef.current = lifecycleSequence;
        const requested = await headsetXrControlRef.current?.requestExit();
        if (requested) {
          return {
            command: "request_exit_xr",
            phase: "awaiting_user_gesture",
            message: "A visible Exit XR request was sent to the paired headset. The user must activate it there; the Agent cannot silently end immersion.",
            capabilities: { lifecycle_sequence: lifecycleSequence },
          };
        }
        return {
          command: "request_exit_xr",
          phase: xrHostPhase(sameDeviceXrStateRef.current.phase, headsetXrStateRef.current.phase),
          message: "No active paired-headset immersive session is reporting live context.",
          capabilities: { lifecycle_sequence: lifecycleSequence },
        };
      }
      const same = sameDeviceXrControlRef.current?.inspect();
      if (same?.phase !== "active") {
        return { command: "request_exit_xr", phase: xrHostPhase(sameDeviceXrStateRef.current.phase, headsetXrStateRef.current.phase), message: "No same-device immersive XR session is active." };
      }
      const action = presentHostAction({
        kind: "exit_immersive_xr",
        label: "Exit immersive XR",
        dedupeKey: "xr:exit:same-device",
        title: "Exit VR",
        message: "The Agent requested that the current immersive session end. The Workspace will remain open and unchanged.",
        confirmLabel: "Exit XR",
        confirm: async () => { await sameDeviceXrControlRef.current?.exitFromUserGesture(); },
      });
      return {
        command: "request_exit_xr",
        phase: "awaiting_user_gesture",
        message: "XR exit awaits user confirmation.",
        required_user_action: action,
      };
    },
    getLiveXrContext: async (input) => {
      const spatial = hybridCanvasRef.current?.getRenderer()?.captureXRSpatialContext();
      const state = workspaceStoreRef.current?.getState();
      const maximumAgeMs = typeof input.maximum_age_ms === "number" ? input.maximum_age_ms : 1_000;
      if (!state) throw new AgentHostControlError("xr_context_unavailable", "The Workspace is unavailable.");
      const now = Date.now();
      let context: XRContextEnvelope | undefined;
      let source: "same_device" | "remote_headset" | undefined;
      let ageMs = 0;
      if (spatial && hybridCanvasRef.current?.isXRPresenting()) {
        const sameDeviceContext = createXRContextEnvelope({
          source: "immersive-xr",
          workspaceId: state.workspaceId,
          workspaceRevision: state.revision,
          capturedAtMs: now,
          ...spatial,
          ...(selectedComponentId ? { selectedComponentId } : {}),
        });
        if ((sameDeviceContext.tracking.state === "tracked" || sameDeviceContext.tracking.state === "limited")
          && sameDeviceContext.tracking.sourceAgeMs <= maximumAgeMs) {
          context = sameDeviceContext;
          source = "same_device";
          ageMs = sameDeviceContext.tracking.sourceAgeMs;
        }
      } else {
        const remote = remoteXrContextRef.current;
        if (remote && isRemoteXrContextFresh({
          contextWorkspaceId: remote.context.workspaceId,
          contextWorkspaceRevision: remote.context.workspaceRevision,
          expectedWorkspaceId: state.workspaceId,
          expectedWorkspaceRevision: state.revision,
          receivedAtMs: remote.receivedAtMs,
          nowMs: now,
          relayQueueAgeMs: remote.relayQueueAgeMs,
          sourceAgeMs: remote.context.tracking.sourceAgeMs,
          trackingState: remote.context.tracking.state,
          maximumAgeMs,
        })) {
          context = remote.context;
          source = "remote_headset";
          ageMs = remoteXrContextKnownAgeMs({
            receivedAtMs: remote.receivedAtMs,
            nowMs: now,
            relayQueueAgeMs: remote.relayQueueAgeMs,
            sourceAgeMs: remote.context.tracking.sourceAgeMs,
          })!;
        }
      }
      if (!context || !source) {
        throw new AgentHostControlError(
          "xr_context_unavailable",
          "No fresh revision-bound immersive XR context is available from this browser or a paired headset.",
        );
      }
      return {
        command: "get_live_xr_context",
        phase: "active",
        message: `Fresh revision-bound XR context captured from ${source === "same_device" ? "this browser" : "the paired headset"}.`,
        source,
        maximum_age_ms: maximumAgeMs,
        age_ms: ageMs,
        context,
      };
    },
  }), [presentHostAction, runConfirmedVoiceRelayHostAction, selectedComponentId]);

  const handleAgentCommand = useCallback<AgentGatewayCommandHandler>(async (name, input, context) => {
    const commandGeneration = agentCommandGenerationRef.current;
    const assertCurrentCommand = () => {
      if (context.signal.aborted || commandGeneration !== agentCommandGenerationRef.current) {
        throw new DOMException("Agent command cancelled", "AbortError");
      }
    };
    assertCurrentCommand();
    if (agentHostControl.handles(name)) {
      try {
        const result = await agentHostControl.handle(name, input, context);
        assertCurrentCommand();
        return result;
      } catch (cause) {
        if (cause instanceof AgentHostControlError || cause instanceof HostActionLedgerError) {
          throw new AgentGatewayCommandError(
            cause.code,
            cause.message,
            cause instanceof AgentHostControlError ? cause.details : undefined,
          );
        }
        throw cause;
      }
    }
    if (name === "complete_workspace_reconstruction_asset") {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new AgentGatewayCommandError("invalid_request", "The reconstructed asset handoff is invalid.");
      }
      const body = input as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["candidate_handle", "workspace_id"].includes(key)) ||
          typeof body.candidate_handle !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.candidate_handle) ||
          typeof body.workspace_id !== "string" || body.workspace_id !== workspaceStoreRef.current?.getState().workspaceId) {
        throw new AgentGatewayCommandError("invalid_request", "The reconstructed asset does not match the open Workspace.");
      }
      const result = await completeRealityAssetImport(body.candidate_handle, "photo-reconstruction");
      assertCurrentCommand();
      return {
        ok: true,
        data: {
          workspace_id: body.workspace_id,
          result,
        },
      };
    }
    const workspaceRouter = workspaceAgentRouterRef.current;
    if (!workspaceRouter || !workspaceRouter.handles(name)) {
      throw new AgentGatewayCommandError("unsupported_command", `Unsupported Workspace command ${name}.`);
    }
    const result = await workspaceRouter.handle({ id: uid("workspace_command"), name, input });
    assertCurrentCommand();
    if (!result.ok) return result;
    if (name === "get_workspace_instructions") {
      setAgentSessionReady(true);
      setAgentManageOpen(false);
      setAgentHistoryOpen(false);
    }
    if (name === "submit_workspace_batch") {
      const data = result.data as { request_id?: string; resulting_workspace_revision?: number; summary?: string; client_name?: string; status?: string };
      const alreadyRecorded = Boolean(data.request_id && entriesRef.current.some((entry) =>
        entry.id === data.request_id || entry.traceId === data.request_id
      ));
      if (!alreadyRecorded) {
        setEntries((current) => [...current, {
          id: data.request_id ?? uid("workspace_agent_entry"),
          inputRevision: data.resulting_workspace_revision ?? workspaceStoreRef.current?.getRevision() ?? 0,
          text: data.summary ?? "External client updated the component workspace",
          status: "committed",
          source: "agent",
          clientName: data.client_name ?? agentGatewayRef.current?.config?.clientName,
          traceId: data.request_id,
          summary: data.summary,
        }]);
        setDirty(true);
        window.setTimeout(() => recoverySnapshotRef.current(), 0);
      }
    }
    if (name === "undo_workspace_batch" || name === "redo_workspace_batch") {
      const data = result.data as { changed?: unknown };
      if (data.changed === true) {
        setEntries((current) => {
          const next = current.map((entry) => ({ ...entry }));
          if (name === "undo_workspace_batch") {
            const target = [...next].reverse().find((entry) => ["committed", "approximated", "idempotent"].includes(entry.status));
            if (target) target.status = "undone";
          } else {
            const target = next.find((entry) => entry.status === "undone");
            if (target) target.status = "committed";
          }
          return next;
        });
        setDirty(true);
        window.setTimeout(() => recoverySnapshotRef.current(), 0);
      }
    }
    return result;
  }, [agentHostControl, completeRealityAssetImport, setEntries]);
  const liveAgentCommandHandlerRef = useRef<AgentGatewayCommandHandler>(handleAgentCommand);
  liveAgentCommandHandlerRef.current = handleAgentCommand;
  const stableAgentCommandHandler = useCallback<AgentGatewayCommandHandler>(
    (name, input, context) => liveAgentCommandHandlerRef.current(name, input, context),
    [],
  );

  const startAgentBridge = useCallback((client: AgentGatewayClient) => {
    void client.start().catch((error) => {
      if (error instanceof AgentGatewayError && error.gatewayCode === "browser_already_connected") {
        client.stop("disconnected");
        setAgentError(undefined);
        setAgentEnabled(true);
        setAgentBrowserOccupied(true);
        setAgentSessionReady(false);
        setAgentHistoryOpen(false);
        return;
      }
      setAgentBrowserOccupied(false);
      setAgentError(friendlyError(error));
      setAgentStatus("disconnected");
    });
  }, []);

  const claimAndStartAgentBridge = useCallback(async (client: AgentGatewayClient): Promise<boolean> => {
    try {
      const config = await client.claimBrowser();
      setAgentConfig(config);
      setAgentEnabled(config.enabled);
      setAgentBrowserOccupied(false);
      setAgentError(undefined);
      startAgentBridge(client);
      return true;
    } catch (error) {
      if (error instanceof AgentGatewayError && error.gatewayCode === "browser_already_connected") {
        client.stop("disconnected");
        setAgentEnabled(true);
        setAgentBrowserOccupied(true);
        setAgentError(undefined);
        setAgentSessionReady(false);
        setAgentHistoryOpen(false);
        return false;
      }
      throw error;
    }
  }, [startAgentBridge]);

  useEffect(() => {
    if (!AGENT_CONTROL_ENDPOINT) return;
    let cancelled = false;
    const client = new AgentGatewayClient({
      handler: stableAgentCommandHandler,
      clientInstanceId: agentBrowserInstanceIdRef.current,
      onStatus: (status) => {
        if (cancelled) return;
        const live = status === "connected" || status === "applying";
        if (live) agentConnectionWasLiveRef.current = true;
        else if (agentConnectionWasLiveRef.current) {
          agentConnectionWasLiveRef.current = false;
          invalidatePendingHostAction();
          void bestEffortDisarmVoiceRelay();
        }
        setAgentStatus(status);
      },
      onConfig: (config) => {
        if (cancelled) return;
        const nextTrustIdentity = agentConfigTrustIdentity(config);
        if (agentTrustIdentityRef.current !== undefined
          && agentTrustIdentityRef.current !== nextTrustIdentity) {
          invalidatePendingHostAction();
        }
        agentTrustIdentityRef.current = nextTrustIdentity;
        setAgentConfigPhase("ready");
        setAgentConfig(config);
        setAgentEnabled(config.enabled);
        if (config.offerStatus !== "approval_granted") setApprovedAgentClaim(undefined);
        if (!config.enabled) {
          agentConnectionWasLiveRef.current = false;
          void bestEffortDisarmVoiceRelay();
          allowAgentDestructiveRef.current = false;
          setAllowAgentDestructive(false);
          setAgentSessionReady(false);
          setAgentHistoryOpen(false);
          setAgentBrowserOccupied(false);
        }
      },
    });
    agentGatewayRef.current = client;
    setPhotoReconstructionCapability("checking");
    void client.getPhotoReconstructionCapability().then((capability) => {
      if (!cancelled) setPhotoReconstructionCapability(capability);
    }).catch(() => {
      if (!cancelled) setPhotoReconstructionCapability({
        backend: { id: "local-reconstruction", version: "1" },
        available: false,
        reason: "The local photo reconstruction backend is unavailable.",
      });
    });
    void client.fetchConfig().then((config) => {
      if (cancelled) return;
      setAgentConfigPhase("ready");
      setAgentEnabled(config.enabled);
      if (config.enabled) {
        void claimAndStartAgentBridge(client).catch((error) => {
          if (cancelled) return;
          setAgentError(friendlyError(error));
          setAgentStatus("disconnected");
        });
      }
    }).catch((error) => {
      if (cancelled) return;
      setAgentConfigPhase("error");
      setAgentError(friendlyError(error));
      setAgentStatus("disconnected");
    });
    return () => {
      cancelled = true;
      agentTrustIdentityRef.current = undefined;
      invalidatePendingHostAction(false);
      agentConnectionWasLiveRef.current = false;
      void bestEffortDisarmVoiceRelay();
      workspaceAgentControllerRef.current?.revokeAll();
      client.stop("disconnected");
      if (agentGatewayRef.current === client) agentGatewayRef.current = null;
    };
  }, [bestEffortDisarmVoiceRelay, claimAndStartAgentBridge, invalidatePendingHostAction, stableAgentCommandHandler]);

  const enableAgentConnection = useCallback(async (allowDeleteAndClear: boolean) => {
    const client = agentGatewayRef.current;
    if (!client || busy) throw new Error("The local Agent Gateway is unavailable.");
    setAgentError(undefined);
    allowAgentDestructiveRef.current = allowDeleteAndClear;
    setAllowAgentDestructive(allowDeleteAndClear);
    const config = await client.enable();
    setAgentConfig(config);
    setApprovedAgentClaim(undefined);
    setAgentEnabled(true);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    const claimed = await claimAndStartAgentBridge(client);
    if (claimed) notice("Agent connection is ready. Copy the URL into any MCP-capable agent.", "success");
  }, [busy, claimAndStartAgentBridge, notice]);

  const disableAgentConnection = useCallback(async () => {
    const client = agentGatewayRef.current;
    if (busy) throw new Error("Wait for the current workspace change to finish.");
    revokeAgentContexts("control_disabled");
    voiceRelayHostActionTokenRef.current = undefined;
    let revokeWarning = false;
    if (client) {
      try {
        await client.disable();
      } catch {
        client.stop("disabled");
        revokeWarning = true;
      }
    }
    allowAgentDestructiveRef.current = false;
    setAllowAgentDestructive(false);
    setAgentEnabled(false);
    setAgentStatus("disabled");
    setAgentConfig(undefined);
    setApprovedAgentClaim(undefined);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    setAgentBrowserOccupied(false);
    void voiceRelayClientRef.current?.disarm().catch(() => undefined);
    notice(revokeWarning
      ? "Agent control was disabled locally, but the gateway could not confirm remote revocation."
      : "Agent connection disabled. Reconnect to return to the preserved Workspace.", revokeWarning ? "warning" : "success");
  }, [busy, notice, revokeAgentContexts]);

  const leaveOccupiedAgentConnection = useCallback(() => {
    revokeAgentContexts("occupied_connection_released");
    agentGatewayRef.current?.stop("disconnected");
    setAgentBrowserOccupied(false);
    setAgentError(undefined);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    notice("This tab released the Agent connection. External control continues in the other tab.", "success");
  }, [notice, revokeAgentContexts]);

  const revokeAgentPairing = useCallback(async () => {
    const client = agentGatewayRef.current;
    if (!client || busy) throw new Error("The local Agent Gateway is unavailable.");
    const bridgeReady = await replaceAgentOfferAndRestoreBridge(
      async () => (await client.rotatePairing()).config,
      (config) => {
        revokeAgentContexts("pairing_rotated");
        setAgentConfig(config);
        setApprovedAgentClaim(undefined);
        setAgentSessionReady(false);
        setAgentHistoryOpen(false);
        setAgentManageOpen(false);
      },
      (config) => restoreAgentBrowserBridge(
        client,
        config,
        () => claimAndStartAgentBridge(client),
      ),
    );
    if (bridgeReady) notice("The old agent connection was revoked. A fresh link is ready.", "success");
  }, [busy, claimAndStartAgentBridge, notice, revokeAgentContexts]);

  const changeAgentPermission = useCallback((value: boolean) => {
    if (busy) throw new Error("Wait for the current workspace change to finish.");
    if (allowAgentDestructiveRef.current === value) return;
    allowAgentDestructiveRef.current = value;
    setAllowAgentDestructive(value);
    revokeAgentContexts("permission_policy_changed");
    if (agentSessionReady) {
      setAgentSessionReady(false);
      setAgentHistoryOpen(false);
      setAgentManageOpen(false);
      notice("Agent permission policy changed. The client must read the engine instructions again.", "warning");
    }
  }, [agentSessionReady, busy, notice, revokeAgentContexts]);

  const retryAgentConnection = useCallback(async () => {
    const client = agentGatewayRef.current;
    if (!client) throw new Error("The local Agent Gateway is unavailable.");
    setAgentError(undefined);
    const current = await client.fetchConfig();
    setAgentConfigPhase("ready");
    if (!current.enabled) {
      await enableAgentConnection(allowAgentDestructiveRef.current);
      return;
    }
    setAgentConfig(current);
    setAgentEnabled(current.enabled);
    if (current.enabled && !client.running) await claimAndStartAgentBridge(client);
  }, [claimAndStartAgentBridge, enableAgentConnection]);

  const refreshAgentOffer = useCallback(async () => {
    const client = agentGatewayRef.current;
    if (!client || busy) throw new Error("The local Agent Gateway is unavailable.");
    setAgentError(undefined);
    const bridgeReady = await replaceAgentOfferAndRestoreBridge(
      () => client.refreshOffer(),
      (config) => {
        revokeAgentContexts("connection_offer_refreshed");
        setAgentConfig(config);
        setApprovedAgentClaim(undefined);
        setAgentEnabled(config.enabled);
        setAgentSessionReady(false);
        setAgentHistoryOpen(false);
      },
      (config) => restoreAgentBrowserBridge(
        client,
        config,
        () => claimAndStartAgentBridge(client),
      ),
    );
    if (bridgeReady) notice("A fresh agent connection URL is ready.", "success");
  }, [busy, claimAndStartAgentBridge, notice, revokeAgentContexts]);

  const takeoverAgentControl = useCallback(async () => {
    const client = agentGatewayRef.current;
    if (!client || busy) throw new Error("The local Agent Gateway is unavailable.");
    if (client.running) client.stop("disconnected");
    const config = await client.takeover();
    setAgentConfig(config);
    setApprovedAgentClaim(undefined);
    setAgentEnabled(config.enabled);
    setAgentBrowserOccupied(false);
    setAgentError(undefined);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    startAgentBridge(client);
    notice("Agent control moved to this tab. Ask the client to read the Workspace instructions again.", "success");
  }, [busy, notice, startAgentBridge]);

  const approveAgentClaim = useCallback(async () => {
    const client = agentGatewayRef.current;
    const claimId = agentConfig?.pendingApproval?.claimId;
    if (!client || !claimId || busy) throw new Error("The pending agent approval is no longer available.");
    const approvedClaim = agentConfig.pendingApproval;
    const config = await client.approveClaim(claimId);
    setApprovedAgentClaim({
      name: approvedClaim.clientName || "Unnamed agent",
      clientId: approvedClaim.clientId
        ? `${approvedClaim.clientId} · ${approvedClaim.fingerprint}`
        : approvedClaim.fingerprint,
      scopes: approvedClaim.scopes,
      connected: false,
    });
    setAgentConfig(config);
    notice(`${approvedClaim.clientName || "The agent"} may now read the engine instructions.`, "success");
  }, [agentConfig, busy, notice]);

  const rejectAgentClaim = useCallback(async () => {
    const client = agentGatewayRef.current;
    const claimId = agentConfig?.pendingApproval?.claimId;
    if (!client || !claimId || busy) throw new Error("The pending agent approval is no longer available.");
    await client.denyClaim(claimId);
    setAgentConfig(await client.refreshOffer());
    setApprovedAgentClaim(undefined);
    setAgentSessionReady(false);
    notice("The connection request was rejected. A fresh link is ready.", "success");
  }, [agentConfig, busy, notice]);

  const status = latestStatus(entries);
  const agentIsConnected = agentStatus === "connected" || agentStatus === "applying";
  const pendingApproval = agentConfig?.pendingApproval;
  const externalControlActive = isAgentWorkspaceUnlocked(agentSessionReady, agentStatus);
  useLayoutEffect(() => {
    if (!externalControlActive) hybridCanvasRef.current?.cancelActiveInteractions();
  }, [externalControlActive]);
  useEffect(() => {
    if (externalControlActive) return;
    sceneBridgeLifecycleRef.current += 1;
    const bridgeSession = sceneBridgeSessionRef.current;
    if (bridgeSession) {
      agentGatewayRef.current?.releaseBridgeSession(bridgeSession.sessionId);
      sceneBridgeSessionRef.current = undefined;
    }
    invalidatePendingHostAction();
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    setVoiceRelaySettingsOpen(false);
    setSceneBridgeOpen(false);
    setSceneBridgeSession(undefined);
    setSceneBridgePublication(undefined);
    setSceneBridgeProposals([]);
    setSceneBridgeBusy(false);
    setSceneBridgeError(undefined);
    setConfirm(null);
    setPendingFile(null);
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [externalControlActive, invalidatePendingHostAction]);
  useEffect(() => {
    if (shouldClearRealityMeasurementForWorkspaceGate(externalControlActive, realityMeasurement)) {
      cancelRealityMeasurement();
    }
  }, [cancelRealityMeasurement, externalControlActive, realityMeasurement]);
  const agentExperience = useMemo(() => deriveAgentExperienceState({
    configPhase: agentConfigPhase,
    gatewayStatus: agentStatus,
    config: agentConfig,
    sessionReady: agentSessionReady,
    occupied: agentBrowserOccupied,
    client: approvedAgentClaim,
    gatewayError: agentError,
  }), [agentBrowserOccupied, agentConfig, agentConfigPhase, agentError, agentSessionReady, agentStatus, approvedAgentClaim]);
  const workspaceSnapshot = useMemo(() => toRenderSnapshot(workspace), [workspace]);
  const xrWorldPanels = useMemo(() => {
    const projection = toXrWorkspaceProjection(workspaceSnapshot);
    return presentXrWorldPanels(projection, deriveXrViewerPanelModels(projection));
  }, [workspaceSnapshot]);

  useEffect(() => {
    hybridCanvasRef.current?.setXRWorldPanels?.(xrWorldPanels, workspaceSnapshot.revision);
  }, [workspaceRenderGeneration, workspaceSnapshot.revision, xrWorldPanels]);

  const handleSameDeviceXrPanelAction = useCallback((event: ThreeRendererXRPanelAction) => {
    if (event.workspaceRevision !== workspaceSnapshot.revision
      || event.action.expectedWorkspaceRevision !== workspaceSnapshot.revision) {
      notice("The XR panel action was rejected because its Workspace revision is stale.", "warning");
      return;
    }
    if (event.action.confirmation === "required" && !globalThis.confirm(
      `Allow the XR panel to invoke “${event.action.actionName}” on “${event.action.targetComponentId}”?`,
    )) return;
    invokeWorkspaceAction({
      componentId: event.action.targetComponentId,
      action: event.action.actionName,
      input: event.action.input,
    });
  }, [invokeWorkspaceAction, notice, workspaceSnapshot.revision]);

  const workspaceRenderCommit = useMemo(() => {
    const command = workspaceStoreRef.current?.getCommandHistory()
      .filter((candidate) => candidate.resultingWorkspaceRevision === workspace.revision)
      .at(-1);
    return command ? {
      baseRevision: command.baseWorkspaceRevision,
      resultingRevision: command.resultingWorkspaceRevision,
      operations: command.resolvedOperations,
    } : undefined;
  }, [workspace.revision]);
  const selectedWorkspaceComponent = selectedComponentId
    ? workspaceSnapshot.components.find((component) => component.id === selectedComponentId)
    : undefined;
  const hasSelectedSpatialComponent = selectedWorkspaceComponent?.placement.space === "world3d"
    && Boolean(selectedWorkspaceComponent.props.physics);
  const workspacePhysicsReport = useMemo(
    () => buildPhysicsValidationReport(workspace),
    [workspace],
  );
  const selectedWorkspacePhysicsReport = hasSelectedSpatialComponent
    ? workspacePhysicsReport.bodies.find((body) => body.componentId === selectedComponentId)
    : undefined;
  const selectedWorkspaceResizePolicy = selectedWorkspaceComponent
    ? workspaceResizePolicy(selectedWorkspaceComponent)
    : undefined;
  const selectedWorkspaceWorldPlacement = useMemo(() => {
    if (!selectedComponentId) return undefined;
    const component = workspace.components.get(selectedComponentId);
    if (!component || component.placement.space !== "world3d") return undefined;
    try {
      return localPlacementForWorldTransform(resolveComponentWorldTransform(workspace.components, component.id));
    } catch {
      return undefined;
    }
  }, [selectedComponentId, workspace]);
  const workspaceAssemblyOptions = useMemo(() => {
    const wouldCreateCycle = (candidateId: string): boolean => {
      if (!selectedComponentId) return false;
      let current = workspace.components.get(candidateId);
      const visited = new Set<string>();
      while (current) {
        if (current.id === selectedComponentId) return true;
        if (!current.parentId || visited.has(current.id)) return false;
        visited.add(current.id);
        current = workspace.components.get(current.parentId);
      }
      return false;
    };
    return [...workspace.components.values()]
      .filter((component) => component.type.typeId === "model-assembly"
        && component.placement.space === "world3d"
        && component.id !== selectedComponentId
        && !wouldCreateCycle(component.id))
      .map((component) => ({ id: component.id, label: component.label }))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }, [selectedComponentId, workspace]);
  const workspaceRealityProxyOptions = useMemo(() => [...workspace.components.values()]
    .filter((component) => ["spatial-primitive", "cad-part", "spatial-entity", "model-assembly"].includes(component.type.typeId)
      && component.placement.space === "world3d"
      && component.id !== selectedComponentId)
    .map((component) => ({ id: component.id, label: component.label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)),
  [selectedComponentId, workspace]);
  const workspaceRealityAssets = useMemo<readonly WorkspaceRealityAssetItem[]>(() => (
    [...workspace.realityAssets.values()]
      .map((descriptor) => ({
        descriptor,
        availability: realityAssetAvailability[descriptor.assetId] ?? "checking",
        componentIds: [...workspace.components.values()].flatMap((component) => {
          const reference = realityAssetReference(component.props.assetRef);
          return reference?.assetId === descriptor.assetId && reference.digest === descriptor.digest
            ? [component.id]
            : [];
        }).sort(),
      }))
      .sort((left, right) => left.descriptor.assetId.localeCompare(right.descriptor.assetId))
  ), [realityAssetAvailability, workspace]);
  const selectedWorkspaceDescendantCount = useMemo(() => {
    if (!selectedComponentId) return 0;
    return [...workspace.components.values()].filter((candidate) => {
      let parentId = candidate.parentId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        if (parentId === selectedComponentId) return true;
        visited.add(parentId);
        parentId = workspace.components.get(parentId)?.parentId;
      }
      return false;
    }).length;
  }, [selectedComponentId, workspace]);
  const workspaceModelHierarchyItems = useMemo<readonly WorkspaceModelHierarchyItem[]>(() => {
    const included = new Map([...workspace.components].filter(([, component]) =>
      component.type.typeId === "stage-3d"
      || component.type.typeId === "model-assembly"
      || component.type.typeId === "cad-part"
      || component.type.typeId === "spatial-primitive"
      || component.type.typeId === "spatial-entity"
      || component.type.typeId === "gaussian-splat"));
    const children = new Map<string, string[]>();
    for (const component of included.values()) {
      if (!component.parentId || !included.has(component.parentId)) continue;
      const list = children.get(component.parentId) ?? [];
      list.push(component.id);
      children.set(component.parentId, list);
    }
    const compareIds = (leftId: string, rightId: string) => {
      const left = included.get(leftId)!;
      const right = included.get(rightId)!;
      return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
    };
    for (const list of children.values()) list.sort(compareIds);
    const items: WorkspaceModelHierarchyItem[] = [];
    const visited = new Set<string>();
    const visit = (id: string, depth: number) => {
      if (visited.has(id)) return;
      visited.add(id);
      const component = included.get(id);
      if (!component) return;
      items.push({
        id: component.id,
        label: component.label,
        typeId: component.type.typeId,
        ...(component.parentId ? { parentId: component.parentId } : {}),
        depth,
      });
      for (const childId of children.get(id) ?? []) visit(childId, depth + 1);
    };
    const roots = [...included.values()]
      .filter((component) => !component.parentId || !included.has(component.parentId))
      .map((component) => component.id)
      .sort(compareIds);
    for (const id of roots) visit(id, 0);
    for (const id of [...included.keys()].sort(compareIds)) visit(id, 0);
    return items;
  }, [workspace]);
  const selectedWorkspaceManifestUpgrade = selectedWorkspaceComponent
    ? (() => {
      const current = workspaceStoreRef.current?.getComponentManifest(selectedWorkspaceComponent.type.typeId);
      if (!current || current.trustTier !== "builtin"
        || (current.version === selectedWorkspaceComponent.type.version
          && current.digest === selectedWorkspaceComponent.type.digest)) return undefined;
      return { fromVersion: selectedWorkspaceComponent.type.version, toVersion: current.version };
    })()
    : undefined;
  const workspaceCatalog = useMemo(() => buildWorkspaceComponentCatalog(
    workspaceStoreRef.current?.getComponentCatalog() ?? [],
    {
      hasStage: workspaceSnapshot.components.some((component) => component.type.typeId === "stage-3d"),
    },
  ), [workspaceSnapshot]);
  const workspaceModelDefinitions = useMemo(() => [...workspace.modelDefinitions.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
      || left.version.localeCompare(right.version)
      || left.modelId.localeCompare(right.modelId)), [workspace.modelDefinitions]);
  const workspaceModelExportActions = useMemo<readonly WorkspaceModelExportAction[]>(() => [{
    id: "openusd-usda",
    label: "USDA",
    onExport: exportWorkspaceModel,
  }, {
    id: "solid-stl",
    label: "STL",
    onExport: (definition) => exportWorkspaceModelMesh(definition, "stl"),
    isAvailable: (definition) => modelDefinitionCsgCompatibility(definition).supported,
    unavailableReason: (definition) => modelDefinitionCsgCompatibility(definition).reason
      ?? "This model is outside the STL export subset.",
  }, {
    id: "solid-obj",
    label: "OBJ",
    onExport: (definition) => exportWorkspaceModelMesh(definition, "obj"),
    isAvailable: (definition) => modelDefinitionCsgCompatibility(definition).supported,
    unavailableReason: (definition) => modelDefinitionCsgCompatibility(definition).reason
      ?? "This model is outside the OBJ export subset.",
  }, {
    id: "cad-handoff",
    label: "CAD package",
    onExport: exportWorkspaceModelCadHandoff,
    isAvailable: (definition) => modelDefinitionCadHandoffCompatibility(definition).supported,
    unavailableReason: (definition) => modelDefinitionCadHandoffCompatibility(definition).reason
      ?? "This model is outside the exact CAD handoff subset.",
  }, {
    id: "cad-step",
    label: "STEP",
    onExport: exportWorkspaceModelStep,
    isAvailable: (definition) => modelDefinitionStepCompatibility(definition).supported,
    unavailableReason: (definition) => modelDefinitionStepCompatibility(definition).reason
      ?? "This model is outside the STEP v1 subset.",
  }], [
    exportWorkspaceModel,
    exportWorkspaceModelCadHandoff,
    exportWorkspaceModelMesh,
    exportWorkspaceModelStep,
  ]);
  const bindingDiagnostics = workspaceSnapshot.bindingDiagnostics ?? [];
  const workspaceBindingTargets = useMemo(() => workspaceSnapshot.components.flatMap((component) => {
    const manifest = workspaceStoreRef.current?.getComponentManifest(component.type.typeId, component.type.version);
    if (!manifest || manifest.digest !== component.type.digest) return [];
    const writableProps = manifest.writableProps.filter((property) =>
      !(manifest.typeId === "stage-3d" && property === "dimensions"),
    );
    return writableProps.length ? [{
      id: component.id,
      label: component.label,
      typeId: manifest.typeId,
      writableProps,
    }] : [];
  }), [workspaceSnapshot]);
  const workspaceSources = useMemo(() => [...workspace.resources.values()].map((resource) => {
    const canonicalInline = isCanonicalInlineSnapshotResource(resource);
    const automationDescriptor = hostFeedAutomationDescriptor(resource);
    const hostFeed = Boolean(automationDescriptor);
    const runtime = hostFeedRuntime[resource.id];
    const resourceDiagnostics = bindingDiagnostics.filter((diagnostic) => diagnostic.resourceId === resource.id);
    const sourceBindings = [...workspace.connections.values()].filter((connection): connection is ResourceBinding =>
      connection.kind === "resource_binding" && connection.resourceId === resource.id && connection.enabled,
    );
    const bindingCount = sourceBindings.length;
    const trustedProvenance = canonicalInline || hostFeed ? resource.snapshot?.provenance[0] : undefined;
    return {
      id: resource.id,
      label: resource.label,
      connectorType: resource.connectorType,
      connectorVersion: resource.connectorVersion,
      status: runtime?.refreshing
        ? "refreshing" as const
        : runtime?.error
          ? "stale" as const
        : resource.status === "unconfigured"
          ? "error" as const
          : resource.status,
      retrievedAt: resource.snapshot?.retrievedAt,
      bindingCount,
      diagnostics: resourceDiagnostics,
      ...(trustedProvenance?.publisher ? { provenanceLabel: trustedProvenance.publisher } : {}),
      ...(trustedProvenance?.citation ? { citation: trustedProvenance.citation } : {}),
      ...(runtime?.error ? { lastError: runtime.error } : {}),
      ...(hostFeed ? {
        refreshable: true,
        automationPaused: hostFeedAutomationPaused(
          automationDescriptor!,
          hostFeedAutomationConsentRef.current,
        ),
        hostFeedConfig: {
          url: resource.config.url as string,
          format: resource.config.format as HostFeedFormat,
          policy: structuredClone(resource.policy),
        },
      } : {}),
      bindings: sourceBindings.map((connection) => {
        const component = workspace.components.get(connection.componentId);
        return {
          id: connection.id,
          componentId: connection.componentId,
          componentLabel: component?.label ?? connection.componentId,
          targetProp: connection.targetProp,
          sourcePath: connection.sourcePath ?? "$",
        };
      }),
      ...(canonicalInline && resource.snapshot ? {
        editableJson: JSON.stringify(resource.snapshot.data, null, 2),
        reapplyable: true,
      } : {}),
    };
  }), [hostFeedAutomationRevision, hostFeedRuntime, workspace, workspaceSnapshot]);
  const workspaceValidationView = useMemo(() => buildWorkspaceValidationView({
    workspace,
    physicsReport: workspacePhysicsReport,
    bindingDiagnostics,
    realityAvailability: realityAssetAvailability,
    sources: workspaceSources.map((source) => ({
      id: source.id,
      label: source.label,
      status: source.status,
      automationPaused: source.automationPaused,
      lastError: source.lastError,
    })),
  }), [bindingDiagnostics, realityAssetAvailability, workspace, workspacePhysicsReport, workspaceSources]);
  const autoArrangeWorkspaceLayout = useCallback(() => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) throw new Error("The component workspace is not ready.");
      const changes = planAutoArrangeLayout(store.getState());
      if (changes.size === 0) {
        notice(
          "No movable 2D overlap could be rearranged. Locked panels may need to be moved or unlocked manually.",
          "warning",
        );
        return;
      }
      const operations: WorkspaceOperation[] = [...changes]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, placement], index) => ({
          op: "place_component" as const,
          op_id: `op_auto_arrange_2d_${index + 1}`,
          id,
          placement: structuredClone(placement),
        }));
      applyWorkspaceOperations(
        operations,
        `Auto-arranged ${operations.length} 2D ${operations.length === 1 ? "component" : "components"}`,
      );
      window.setTimeout(() => hybridCanvasRef.current?.frameAll(), 80);
    } catch (error) {
      notice(friendlyError(error), "error");
    }
  }, [applyWorkspaceOperations, notice]);
  const navigateWorkspaceValidation = useCallback((target: WorkspaceValidationTarget) => {
    if (target.componentId) {
      if (!workspaceStoreRef.current?.getState().components.has(target.componentId)) {
        notice("That check target no longer exists in the current Workspace revision.", "warning");
        setWorkspacePanel("validation");
        return;
      }
      setSelectedComponentId(target.componentId);
    }
    setWorkspacePanel(target.surface === "sources"
      ? "sources"
      : target.surface === "reality"
        ? "reality"
        : "inspector");
  }, [notice]);
  const showStartCenter = externalControlActive
    && !startCenterDismissed
    && !recoveryAvailable
    && workspace.components.size === 0
    && workspace.resources.size === 0
    && workspace.modelDefinitions.size === 0;

  const agentConnectionPageProps = {
    id: "agent-manage-panel",
    experience: agentExperience,
    busy,
    error: agentError,
    allowDeleteAndClear: allowAgentDestructive,
    connectionUrl: agentConfig?.connectionUrl,
    expiresAt: agentConfig?.offerStatus === "approved" ? undefined : agentConfig?.offerExpiresAt,
    onEnable: (allowDeleteAndClear: boolean) => runAgentAction(() => enableAgentConnection(allowDeleteAndClear)),
    onCopySetup: async () => {
      return runAgentAction(async () => {
        const client = agentGatewayRef.current;
        if (!client) throw new Error("The local Agent Gateway is unavailable.");
        const pairing = await client.revealPairing();
        return { mcpConfig: pairing.mcpConfig };
      });
    },
    onCopyRestSetup: async () => {
      return runAgentAction(async () => {
        const client = agentGatewayRef.current;
        if (!client) throw new Error("The local Agent Gateway is unavailable.");
        const pairing = await client.revealPairing();
        return { restConfig: pairing.restConfig };
      });
    },
    onPermissionChange: (allowDeleteAndClear: boolean) => runAgentAction(() => changeAgentPermission(allowDeleteAndClear)),
    onRetry: () => runAgentAction(retryAgentConnection),
    onRefreshOffer: () => runAgentAction(refreshAgentOffer),
    onTakeover: agentBrowserOccupied ? () => runAgentAction(takeoverAgentControl) : undefined,
    onApprove: pendingApproval ? () => runAgentAction(approveAgentClaim) : undefined,
    onReject: pendingApproval ? () => runAgentAction(rejectAgentClaim) : undefined,
    onRevoke: () => runAgentAction(revokeAgentPairing),
    onDisableAgentControl: agentBrowserOccupied
      ? () => runAgentAction(leaveOccupiedAgentConnection)
      : () => runAgentAction(disableAgentConnection),
  } satisfies Omit<AgentConnectionPageProps, "onClose">;

  return <Suspense fallback={<main className="agent-connection-gate" aria-label="Loading Workspace">Loading Workspace…</main>}>
  <div className={`app-shell${externalControlActive ? "" : " is-agent-gated"}`}>
    {externalControlActive && <ProjectBar
      projectName={projectName}
      dirty={dirty}
      canUndo={Boolean(workspaceStoreRef.current?.canUndoUserCommand())}
      canRedo={Boolean(workspaceStoreRef.current?.canRedoUserCommand())}
      busy={busy}
      onProjectName={(name) => {
        setProjectName(name);
        setDirty(true);
        window.setTimeout(() => recoverySnapshotRef.current(), 0);
      }}
      onUndo={() => void undo()}
      onRedo={() => void redo()}
      onOpen={() => fileRef.current?.click()}
      onSave={save}
      onSavePortable={() => void savePortableProject()}
      onExportExchange={() => void exportSceneExchange()}
      onOpenBridge={() => { setSceneBridgeError(undefined); setSceneBridgeOpen(true); }}
      onNew={() => setConfirm("new")}
    />}
    <AgentWorkspaceGate
      active={externalControlActive}
      connection={<AgentConnectionPage {...agentConnectionPageProps} />}
    >
      <Viewport
        status={status}
        entityCount={workspace.components.size}
        revision={workspace.revision}
        agentControlStatus={agentEnabled ? (agentStatus === "applying"
          ? `Applying ${agentConfig?.clientName?.trim() || "agent"} change`
          : externalControlActive
            ? `${agentConfig?.clientName?.trim() || "Agent"} connected`
            : "Agent connection ready") : undefined}
        interactionDisabled={agentManageOpen || !externalControlActive}
        onFrameAll={() => hybridCanvasRef.current?.frameAll()}
        onResetView={() => hybridCanvasRef.current?.resetView()}
        onZoomIn={() => hybridCanvasRef.current?.zoomIn()}
        onZoomOut={() => hybridCanvasRef.current?.zoomOut()}
        xrControl={<XRSetupAssistant
          disabled={agentManageOpen}
          sameDeviceRef={sameDeviceXrControlRef}
          headsetRef={headsetXrControlRef}
          voiceRelayArmed={Boolean(voiceRelayStatus?.armed)}
          voiceRelayTargetLabel={voiceRelayStatus?.target?.label}
          onConfigureVoiceRelay={() => {
            setVoiceRelaySettingsOpen(true);
            void inspectVoiceRelaySettings().catch(() => undefined);
          }}
          sameDevice={{
            getCanvas: () => hybridCanvasRef.current,
            onPhaseChange: (phase, message) => {
              sameDeviceXrStateRef.current = { phase, message };
              if (phase === "active") notice("Immersive XR is active. The Workspace remains browser-authoritative.", "success");
              if (phase === "error") notice(message, "warning");
            },
          }}
          headset={{
            snapshot: workspaceSnapshot,
            registryIdentity: DEFAULT_COMPONENT_REGISTRY.digest,
            desktopControlsVisible: externalControlActive,
            voiceRelayEnabled: Boolean(
              voiceRelayStatus?.enabled && voiceRelayStatus.armed && voiceRelayStatus.target,
            ),
            openRealityAsset,
            onSelect: setSelectedComponentId,
            onActivate: (componentId) => activateWorkspaceComponent({ componentId }),
            onPanelAction: (action) => invokeWorkspaceAction({
              componentId: action.targetComponentId,
              action: action.actionName,
              input: action.input,
            }),
            onSpatialContext: (context, source) => {
              remoteXrContextRef.current = Object.freeze({
                context,
                receivedAtMs: Date.now(),
                relayServerReceivedAtMs: source.serverReceivedAtMs,
                relayQueueAgeMs: source.serverQueueAgeMs,
              });
            },
            onPhaseChange: (phase, message) => {
              headsetXrStateRef.current = { phase, message };
              if (phase !== "active") remoteXrContextRef.current = undefined;
              if (phase === "active") notice("The paired headset is reporting live immersive context.", "success");
              if (phase === "error") notice(message, "warning");
            },
          }}
        />}
      >
        <HybridWorkspaceCanvas
          key={`workspace-canvas-${workspaceRenderGeneration}-${realityRenderGeneration}`}
          ref={hybridCanvasRef}
          state={workspaceSnapshot}
          commit={workspaceRenderCommit}
          rendererOptions={{ threeOptions: { openRealityAsset } }}
          selectedId={selectedComponentId}
          onSelect={setSelectedComponentId}
          onActivate={activateWorkspaceComponent}
          onRealityMeasurement={handleRealityMeasurement}
          onAnimationComplete={completeWorkspaceAnimation}
          onXRPanelAction={handleSameDeviceXrPanelAction}
          onXRPanelWarning={(warning) => notice(warning.message, "warning")}
          onAction={invokeWorkspaceAction}
          onCommitPlacement={commitWorkspacePlacement}
          getResizePolicy={workspaceResizePolicy}
          onCommitResize={commitWorkspaceResize}
          onStatus={(next) => {
            if (next.kind === "three-error" || next.kind === "overlay-error") notice(next.message, "warning");
            if (next.kind === "projection-warning") notice(next.message, "warning");
          }}
          onRendererReady={() => {
            const container = hybridCanvasRef.current?.getContainer();
            if (container) container.dataset.sceneEngineReady = "true";
            hybridCanvasRef.current?.setXRWorldPanels?.(xrWorldPanels, workspaceSnapshot.revision);
          }}
        />
        {showStartCenter && <WorkspaceStartPanel
          disabled={busy}
          agentName={agentConfig?.clientName}
          onBuildSpace={() => {
            const created = createWorkspaceComponent("stage-3d");
            if (!created) return;
            setStartCenterDismissed(true);
            setWorkspacePanel("library");
          }}
          onCreateDashboard={() => {
            setStartCenterDismissed(true);
            setWorkspacePanel("library");
          }}
          onOpenReality={() => {
            setStartCenterDismissed(true);
            setWorkspacePanel("reality");
          }}
          onConnectData={() => {
            setStartCenterDismissed(true);
            setWorkspacePanel("sources");
          }}
          onTryExample={() => {
            createMixedWorkspaceShowcase();
            setStartCenterDismissed(true);
          }}
          onOpenProject={() => fileRef.current?.click()}
          onDismiss={() => setStartCenterDismissed(true)}
        />}
        <WorkspaceChrome
          key={`workspace-chrome-${workspaceRenderGeneration}`}
          catalog={workspaceCatalog}
          selected={selectedWorkspaceComponent}
          selectedPhysicsReport={selectedWorkspacePhysicsReport}
          sources={workspaceSources}
          bindingTargets={workspaceBindingTargets}
          bindingDiagnostics={bindingDiagnostics}
          validationView={workspaceValidationView}
          onValidationNavigate={navigateWorkspaceValidation}
          onAutoArrange2D={autoArrangeWorkspaceLayout}
          disabled={busy || !externalControlActive}
          panelState={workspacePanel}
          onPanelStateChange={setWorkspacePanel}
          configureRequestId={workspaceConfigureRequestId}
          onConfigureRequestChange={setWorkspaceConfigureRequestId}
          onCreate={createWorkspaceComponent}
          onUpdate={updateWorkspaceComponent}
          onAction={invokeWorkspaceAction}
          resizePolicy={selectedWorkspaceResizePolicy}
          onResize={commitWorkspaceResize}
          onVisualEffects={commitWorkspaceVisualEffects}
          manifestUpgrade={selectedWorkspaceManifestUpgrade}
          onUpgradeManifest={upgradeWorkspaceComponentManifest}
          onCreateAssembly={createWorkspaceModelAssembly}
          selectedWorldPlacement={selectedWorkspaceWorldPlacement}
          assemblyOptions={workspaceAssemblyOptions}
          realityProxyOptions={workspaceRealityProxyOptions}
          realityMeasurement={realityMeasurement}
          onStartRealityMeasurement={startRealityMeasurement}
          onCancelRealityMeasurement={cancelRealityMeasurement}
          onTransform={transformWorkspaceComponent}
          onReparent={reparentWorkspaceComponent}
          onSelectComponent={setSelectedComponentId}
          selectedDescendantCount={selectedWorkspaceDescendantCount}
          onDeleteComponent={deleteWorkspaceComponent}
          modelDefinitions={workspaceModelDefinitions}
          modelHierarchyItems={workspaceModelHierarchyItems}
          onPublishModel={publishWorkspaceModel}
          onInstantiateModel={instantiateWorkspaceModel}
          modelExportActions={workspaceModelExportActions}
          onDeleteModel={deleteWorkspaceModel}
          onCreateModelExample={createParametricWorkbench}
          realityAssets={workspaceRealityAssets}
          realityImportBusy={realityImportBusy}
          realityImportStatus={realityImportStatus ?? (realityAssetVaultRef.current.persistent
            ? undefined
            : "Private persistent storage is unavailable; imported bytes last for this App session only.")}
          realityReconstructionCapability={photoReconstructionCapability}
          realityReconstructionProfile={photoReconstructionProfile}
          realityReconstructionJob={photoReconstructionJob}
          realityReconstructionBusy={photoReconstructionBusy}
          realityReconstructionStatus={photoReconstructionStatus}
          onImportRealityAsset={() => chooseRealityAssetFile()}
          onReconstructRealityFromPhotos={choosePhotoSet}
          onRealityReconstructionProfile={setPhotoReconstructionProfile}
          onCancelRealityReconstruction={() => void cancelPhotoReconstruction()}
          onRelinkRealityAsset={chooseRealityAssetFile}
          onDeleteRealityAsset={deleteRealityAsset}
          onCreateShowcase={createMixedWorkspaceShowcase}
          onSaveInlineSource={saveWorkspaceInlineSource}
          onRefreshSource={(resourceId) => void refreshWorkspaceHostFeed(resourceId)}
          onPreviewHostFeed={previewWorkspaceHostFeed}
          onSaveHostFeed={saveWorkspaceHostFeed}
          onCommitSourceWithNewTarget={commitWorkspaceSourceWithNewTarget}
          sourceScopeKey={`${workspaceRenderGeneration}:${workspace.workspaceId}`}
          onUnbindSource={unbindWorkspaceSource}
          onDeleteSource={deleteWorkspaceSource}
          sourcesOnly={false}
        />
      </Viewport>
      {agentManageOpen && <AgentConnectionPage
        {...agentConnectionPageProps}
        onClose={() => setAgentManageOpen(false)}
      />}
      <AgentWorkspaceControls
        status={agentStatus === "applying" ? "applying" : externalControlActive ? "connected" : "disconnected"}
        clientName={agentConfig?.clientName || "Agent"}
        historyCount={entries.length}
        historyExpanded={agentHistoryOpen}
        manageExpanded={agentManageOpen}
        onHistory={() => { setAgentHistoryOpen((value) => !value); setAgentManageOpen(false); }}
        onManage={() => { setAgentManageOpen((value) => !value); setAgentHistoryOpen(false); }}
      />
      <AgentHistoryDrawer open={agentHistoryOpen} entries={entries} onClose={() => setAgentHistoryOpen(false)} />
    </AgentWorkspaceGate>
    {externalControlActive && recoveryAvailable && workspace.revision === 0 && workspace.components.size === 0 && <div className="recovery-banner" role="region" aria-label="Project recovery"><span>A local recovery is available.</span><button type="button" onClick={() => void restoreRecovery()}>Continue recovered project</button><button type="button" onClick={() => void dismissRecovery()}>Dismiss</button></div>}
    <input ref={fileRef} hidden type="file" accept=".semaframe-project,.json,.semaframe.json,application/vnd.semaframe.project+zip,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) { if (dirty) { setPendingFile(file); setConfirm("open"); } else void loadProject(file); } event.target.value = ""; }} />
    <input ref={realityFileRef} hidden type="file" accept=".ply,.spz,.sog,.zip,application/ply,application/x-spz,model/vnd.sog,application/zip" onChange={(event) => { const file = event.target.files?.[0]; const relinkAssetId = pendingRealityRelinkRef.current ?? undefined; pendingRealityRelinkRef.current = null; if (file) void importRealityAssetFile(file, relinkAssetId); event.target.value = ""; }} />
    <input ref={photoSetFileRef} hidden type="file" multiple accept=".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(event) => { const files = [...(event.target.files ?? [])]; if (files.length) void reconstructPhotoSet(files); event.target.value = ""; }} />
    <ConfirmDialog open={externalControlActive && confirm === "new"} title="Start a new project?" detail={dirty ? "You have unsaved changes. Save a copy first if you want to return to this workspace." : "This starts an empty workspace. Add a 3D Stage only when you need a 3D world."} confirmLabel="Start new" tone={dirty ? "danger" : "default"} onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void resetProject(); }} />
    <ConfirmDialog open={externalControlActive && confirm === "open"} title="Open another project?" detail="Your current project has unsaved changes. Opening another file will replace it in this window." confirmLabel="Open project" tone="danger" onCancel={() => { setConfirm(null); setPendingFile(null); }} onConfirm={() => { const file = pendingFile; setConfirm(null); setPendingFile(null); if (file) void loadProject(file); }} />
    <VoiceRelaySettingsDialog
      open={externalControlActive && voiceRelaySettingsOpen}
      status={voiceRelayStatus}
      preparation={voiceRelayPreparation}
      diagnostics={voiceRelayDiagnostics}
      error={voiceRelaySettingsError}
      onClose={() => setVoiceRelaySettingsOpen(false)}
      onPrepare={prepareVoiceRelaySettings}
      onConfigureTarget={configureVoiceRelayTarget}
      onRunDiagnostics={diagnoseVoiceRelaySettings}
      onArm={armVoiceRelaySettings}
      onDisarm={disarmVoiceRelaySettings}
    />
    <SceneBridgeDialog
      open={externalControlActive && sceneBridgeOpen}
      session={sceneBridgeSession}
      publication={sceneBridgePublication}
      proposals={sceneBridgeProposalItems}
      busy={sceneBridgeBusy}
      error={sceneBridgeError}
      onClose={() => setSceneBridgeOpen(false)}
      onCreate={createSceneBridgeSession}
      onPublish={publishLatestSceneBridge}
      onRefreshProposals={refreshSceneBridgeProposals}
      onApplyProposal={applySceneBridgeProposal}
      onDiscardThrough={discardSceneBridgeProposals}
      onCloseSession={closeSceneBridgeSession}
    />
    <HostActionPrompt request={externalControlActive ? hostActionPrompt : undefined} onConfirm={confirmHostAction} onCancel={cancelHostAction} />
    <div className="toast-stack">{notices.map((item) => <div key={item.id} className={`toast tone-${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>{item.message}</div>)}</div>
    <div className="sr-status" role={status === "failed" ? "alert" : "status"} aria-live={status === "failed" ? "assertive" : "polite"} aria-atomic="true">{statusLabel(status)}</div>
  </div>
  </Suspense>;
}
