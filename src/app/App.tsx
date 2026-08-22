import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  AgentGatewayClient,
  AgentGatewayCommandError,
  AgentGatewayError,
  type AgentGatewayCommandHandler,
  type AgentGatewayConfig,
  type AgentGatewayStatus,
} from "../agent/AgentGatewayClient";
import { ConfirmDialog } from "./components/ConfirmDialog";
import {
  AgentConnectionPage,
  type AgentConnectionClient,
  type AgentConnectionPageProps,
  type AgentConnectionStatus,
} from "./components/AgentConnectionPage";
import { statusLabel } from "./components/StatusPill";
import type { HybridWorkspaceCanvasHandle } from "./components/workspace/HybridWorkspaceCanvas";
import type {
  WorkspaceComponentResizeRequest,
  WorkspaceComponentHierarchyRequest,
  WorkspaceComponentTransformRequest,
  WorkspaceComponentUpdateRequest,
  WorkspaceComponentVisualEffectsRequest,
} from "./components/workspace/WorkspaceInspector";
import type { ComponentCreationOptions } from "./components/workspace/WorkspaceComponentLibrary";
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
import type { WorkspaceInlineSourceSaveRequest } from "./components/workspace/WorkspaceSourcePanel";
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
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../workspace/persistence";
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
  exportModelDefinitionCsgArtifactInWorker,
  exportModelDefinitionToStep,
  exportParametricModelToUsda,
  modelDefinitionCsgCompatibility,
  modelDefinitionStepCompatibility,
  modelDefinitionRef,
  modelDefinitionToOpenUsdDocument,
  parseParametricPrimitive,
  type ModelDefinition,
} from "../workspace/modeling";
import { historyEntriesForStore } from "./workspaceHistory";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "./browserStorage";
import { RealityAssetCompletionLedger } from "./realityAssetCompletion";
import {
  BrowserAssetVault,
  MemoryAssetVault,
  RealityAssetError,
  preflightRealityAssetInWorker,
  type AssetVault,
  type RealityAssetCandidate,
  type RealityAssetDescriptor,
} from "../workspace/assets";
import type { RealityMeasurementEvent } from "../renderer/reality";

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

function uid(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
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

type RecoverableAgentBridgeClient = Pick<AgentGatewayClient, "running" | "start" | "stop">;

/**
 * Restores this tab's browser-engine lease after an offer mutation. A gateway
 * restart can make a refresh/rotation succeed against a new process while the
 * old polling loop is still unwinding, so wait for that loop before claiming
 * the new lease.
 */
export async function restoreAgentBrowserBridge(
  client: RecoverableAgentBridgeClient,
  config: Pick<AgentGatewayConfig, "engineConnected">,
  claimAndStart: () => Promise<boolean>,
): Promise<boolean> {
  if (client.running && config.engineConnected) return true;
  if (client.running) {
    const previousRun = client.start();
    client.stop("disconnected");
    await previousRun.catch(() => undefined);
  }
  return claimAndStart();
}

/**
 * Keeps local capabilities valid until the remote offer replacement is
 * confirmed. Once confirmed, local state must move to the new offer even when
 * restoring the browser lease subsequently fails.
 */
export async function replaceAgentOfferAndRestoreBridge(
  replaceOffer: () => Promise<AgentGatewayConfig>,
  onOfferReplaced: (config: AgentGatewayConfig) => void,
  restoreBridge: (config: AgentGatewayConfig) => Promise<boolean>,
): Promise<boolean> {
  const config = await replaceOffer();
  onOfferReplaced(config);
  return restoreBridge(config);
}

/** The visual Workspace is private until an approved client completes its instruction handshake. */
export function isAgentWorkspaceUnlocked(
  sessionReady: boolean,
  status: AgentGatewayStatus,
): boolean {
  return sessionReady && (status === "connected" || status === "applying");
}

/** Ephemeral renderer measurements must never outlive the gated Workspace canvas. */
export function shouldClearRealityMeasurementForWorkspaceGate(
  workspaceActive: boolean,
  measurement: RealityMeasurementEvent | undefined,
): boolean {
  return !workspaceActive && measurement !== undefined;
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

function binaryBlobPart(contents: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(contents.byteLength);
  copy.set(contents);
  return copy.buffer;
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function latestStatus(entries: WorkspaceHistoryEntry[]): WorkspaceHistoryStatus {
  return entries.at(-1)?.status ?? "ready";
}

function defaultWorkspacePlacement(manifest: ComponentManifest, ordinal: number): ComponentPlacement {
  if (manifest.typeId === "stage-3d") {
    return {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }
  if (manifest.allowedPlacements.includes("viewport")) {
    const isVideoPlayer = manifest.typeId === "video-player";
    const resizePolicy = resizePolicyForPlacement(manifest, "viewport");
    const size = resizePolicy.kind === "box2d"
      ? structuredClone(resizePolicy.defaultSize)
      : { width: 340, height: 220 };
    return {
      space: "viewport",
      anchor: manifest.typeId === "timer" ? "top_right" : "center",
      offset: manifest.typeId === "timer"
        ? { x: -28, y: 58 + (ordinal % 3) * 18 }
        : isVideoPlayer
          ? { x: 0, y: 0 }
        : { x: (ordinal % 5) * 24 - 48, y: (ordinal % 4) * 20 - 30 },
      size,
      zIndex: 20 + ordinal,
    };
  }
  if (manifest.allowedPlacements.includes("canvas2d")) {
    const resizePolicy = resizePolicyForPlacement(manifest, "canvas2d");
    return {
      space: "canvas2d",
      position: { x: 80 + (ordinal % 5) * 36, y: 90 + (ordinal % 4) * 30 },
      size: resizePolicy.kind === "box2d"
        ? structuredClone(resizePolicy.defaultSize)
        : { width: 340, height: 220 },
      zIndex: ordinal,
    };
  }
  return {
    space: "world3d",
    position: { x: (ordinal % 5) * 1.4 - 2.8, y: 0, z: Math.floor(ordinal / 5) * -1.5 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export default function App() {
  const workspaceStoreRef = useRef<WorkspaceStore | null>(null);
  if (!workspaceStoreRef.current) {
    workspaceStoreRef.current = new WorkspaceStore({
      registry: DEFAULT_COMPONENT_REGISTRY,
    });
  }
  const realityAssetVaultRef = useRef<AppRealityAssetVault | null>(null);
  if (!realityAssetVaultRef.current) realityAssetVaultRef.current = createAppRealityAssetVault();
  const hybridCanvasRef = useRef<HybridWorkspaceCanvasHandle>(null);
  const workspaceAgentControllerRef = useRef<WorkspaceAgentController | null>(null);
  const workspaceAgentRouterRef = useRef<WorkspaceAgentCommandRouter | null>(null);
  const completeRealityAssetImportRef = useRef<((candidateHandle: string) => Promise<JSONObject>) | null>(null);
  const realityAssetCompletionLedgerRef = useRef(
    new RealityAssetCompletionLedger<AppRealityAssetCompletion>(),
  );
  const agentGatewayRef = useRef<AgentGatewayClient | null>(null);
  const recoverySnapshotRef = useRef<() => void>(() => undefined);
  const allowAgentDestructiveRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const realityFileRef = useRef<HTMLInputElement>(null);
  const pendingRealityRelinkRef = useRef<string | null>(null);
  const realityImportAbortRef = useRef<AbortController | null>(null);
  const realityVaultLifecycleRef = useRef(0);
  const workspaceUnsubscribeRef = useRef<(() => void) | null>(null);
  const workspaceSerializerRef = useRef(new WorkspaceProjectSerializer(DEFAULT_COMPONENT_REGISTRY));
  const workspaceModelExportGateRef = useRef(new WorkspaceModelExportGate());
  const createdAtRef = useRef(new Date().toISOString());
  const agentBrowserInstanceIdRef = useRef(stableAgentBrowserInstanceId());
  const [workspace, setWorkspace] = useState<Readonly<WorkspaceState>>(workspaceStoreRef.current.getState());
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
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
  const [approvedAgentClaim, setApprovedAgentClaim] = useState<AgentConnectionClient>();
  const [agentError, setAgentError] = useState<string>();
  const [agentBrowserOccupied, setAgentBrowserOccupied] = useState(false);
  const [allowAgentDestructive, setAllowAgentDestructive] = useState(false);
  const [realityAssetAvailability, setRealityAssetAvailability] = useState<Record<string, RealityAssetAvailability>>({});
  const [realityImportStatus, setRealityImportStatus] = useState<string>();
  const [realityImportBusy, setRealityImportBusy] = useState(false);
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

  const advanceWorkspaceGeneration = useCallback(() => {
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
    setHostFeedRuntime({});
    setHostFeedAutomationRevision((current) => current + 1);
    workspaceGenerationRef.current += 1;
    setWorkspaceRenderGeneration(workspaceGenerationRef.current);
  }, []);

  useEffect(() => {
    const lifecycle = ++realityVaultLifecycleRef.current;
    return () => {
      realityImportAbortRef.current?.abort();
      // React StrictMode intentionally performs a setup/cleanup/setup cycle.
      // Delay disposal one microtask so the second setup can retain the vault,
      // while a real unmount still closes its database and Worker resources.
      queueMicrotask(() => {
        if (realityVaultLifecycleRef.current === lifecycle) {
          realityAssetVaultRef.current?.vault.dispose();
        }
      });
    };
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
    workspaceAgentControllerRef.current?.revokeAll();
  }, []);

  const stopAgentForProjectChange = useCallback(async (reason: string) => {
    revokeAgentContexts(reason);
    const client = agentGatewayRef.current;
    if (!agentBrowserOccupied) {
      try {
        await client?.disable();
      } catch {
        client?.stop("disabled");
      }
    } else client?.stop("disconnected");
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
  }, [agentBrowserOccupied, revokeAgentContexts]);

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

  const recoverySnapshot = useCallback(() => {
    try {
      const store = workspaceStoreRef.current;
      if (!store) return;
      const project = workspaceSerializerRef.current.fromStore(
        projectId,
        store,
        { createdAt: createdAtRef.current },
      );
      const stored = safeStorageSet(RECOVERY_KEY, JSON.stringify({
        version: 1,
        projectName,
        project,
      }));
      if (!stored && !recoveryStorageWarningRef.current) {
        recoveryStorageWarningRef.current = true;
        notice("Local recovery is unavailable because browser storage is full or blocked. Download a copy to protect your work.", "warning");
      }
    } catch (error) {
      if (!recoveryStorageWarningRef.current) {
        recoveryStorageWarningRef.current = true;
        notice(`Local recovery is unavailable: ${friendlyError(error)}`, "warning");
      }
    }
  }, [notice, projectId, projectName]);
  recoverySnapshotRef.current = recoverySnapshot;

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

  const loadProject = useCallback(async (file: File) => {
    await runExclusive(async () => {
      try {
        if (file.size > MAX_WORKSPACE_PROJECT_BYTES) {
          throw new Error(`Project exceeds the ${MAX_WORKSPACE_PROJECT_BYTES} byte limit.`);
        }
        const raw = await file.text();
        const project = workspaceSerializerRef.current.deserialize(raw);
        const nextWorkspaceStore = workspaceSerializerRef.current.openStore(project);
        const restoredName = file.name.replace(/\.semaframe\.json$|\.json$/i, "");
        await stopAgentForProjectChange("project_opened");

        workspaceStoreRef.current = nextWorkspaceStore;
        installWorkspaceAgentController(nextWorkspaceStore);
        connectWorkspaceStore(nextWorkspaceStore);
        setProjectId(project.projectId);
        createdAtRef.current = project.createdAt;
        setProjectName(restoredName);
        setEntries(historyEntriesForStore(nextWorkspaceStore));
        setDirty(false);
        setRecoveryAvailable(false);

        const stored = safeStorageSet(RECOVERY_KEY, JSON.stringify({ version: 1, projectName: restoredName, project }));
        if (!stored) {
          recoveryStorageWarningRef.current = true;
          notice("Workspace opened, but local recovery could not be stored. Download a copy to protect it.", "warning");
        } else {
          recoveryStorageWarningRef.current = false;
          notice("Workspace opened from its validated resolved history.", "success");
        }
      } catch (error) {
        notice(`This Workspace project could not be opened. Your current project is unchanged. ${friendlyError(error)}`, "error");
      }
    });
  }, [connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange]);

  const resetProject = useCallback(async () => {
    await runExclusive(async () => {
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
      setDirty(false);
      createdAtRef.current = new Date().toISOString();
      if (!safeStorageRemove(RECOVERY_KEY)) {
        notice("New Workspace created, but browser recovery storage could not be cleared.", "warning");
      }
      setRecoveryAvailable(false);
    });
  }, [connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange]);

  const restoreRecovery = useCallback(async () => {
    await runExclusive(async () => {
      const raw = safeStorageGet(RECOVERY_KEY);
      if (!raw) { setRecoveryAvailable(false); return; }
      try {
        const recovered = JSON.parse(raw) as { version?: number; projectName?: string; project?: WorkspaceProjectFile };
        if (recovered.version !== 1 || !recovered.project) throw new Error("Recovery snapshot is incomplete or retired.");
        const project = workspaceSerializerRef.current.deserialize(recovered.project);
        const nextWorkspaceStore = workspaceSerializerRef.current.openStore(project);
        await stopAgentForProjectChange("recovery_restored");
        workspaceStoreRef.current = nextWorkspaceStore;
        installWorkspaceAgentController(nextWorkspaceStore);
        connectWorkspaceStore(nextWorkspaceStore);
        setProjectId(project.projectId);
        setProjectName(recovered.projectName || "Recovered world");
        createdAtRef.current = project.createdAt;
        setEntries(historyEntriesForStore(nextWorkspaceStore));
        setDirty(true);
        setRecoveryAvailable(false);
        notice("Recovered your last local Workspace snapshot.", "success");
      } catch (error) {
        safeStorageRemove(RECOVERY_KEY);
        setRecoveryAvailable(false);
        notice(`Recovery could not be opened: ${friendlyError(error)}`, "error");
      }
    });
  }, [connectWorkspaceStore, installWorkspaceAgentController, notice, runExclusive, stopAgentForProjectChange]);

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
  }, [busy, redo, save, undo]);

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
      const placement = defaultWorkspacePlacement(manifest, store.getState().components.size);
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
    } catch (error) {
      notice(friendlyError(error), "error");
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

  const announceRealityAssetCompletion = useCallback((completion: AppRealityAssetCompletion) => {
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
    setRealityAssetAvailability((values) => ({
      ...values,
      [completion.descriptor.assetId]: "available",
    }));
    setRealityRenderGeneration((generation) => generation + 1);
    setRealityImportStatus("Agent import verified and stored. The asset is ready for a Gaussian Splat component.");
    notice("Agent imported a verified visual-only Reality asset.", "success");
  }, [notice, setEntries]);

  const completeRealityAssetImport = useCallback(async (candidateHandle: string): Promise<JSONObject> => {
    const completed = await runExclusive(async () => {
      const client = agentGatewayRef.current;
      const store = workspaceStoreRef.current;
      if (!client || !store) throw new Error("The authoritative browser importer is unavailable.");
      const initialState = store.getState();
      const workspaceId = initialState.workspaceId;
      const baseRevision = initialState.revision;
      const workspaceGeneration = workspaceGenerationRef.current;
      const completionContext = `${workspaceGeneration}:${workspaceId}`;
      const pendingCompletion = realityAssetCompletionLedgerRef.current.peek(
        candidateHandle,
        completionContext,
      );
      if (pendingCompletion) {
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
        announceRealityAssetCompletion(retried);
        return structuredClone(retried.result);
      }
      let stored: Awaited<ReturnType<typeof putRealityAssetBytes>> | undefined;
      let registeredNow = false;
      let hadRegistration = false;
      try {
        const inspected = await client.inspectAssetCandidate(candidateHandle, workspaceId);
        const opened = await client.openAssetCandidate(candidateHandle, workspaceId);
        if (opened.descriptor.candidateHandle !== inspected.candidateHandle
          || opened.descriptor.sha256 !== inspected.sha256
          || opened.descriptor.byteLength !== inspected.byteLength
          || opened.descriptor.format !== inspected.format) {
          await opened.body.cancel().catch(() => undefined);
          throw new Error("The staged Reality asset changed between inspection and streaming.");
        }
        const blob = await new Response(opened.body, {
          headers: { "Content-Type": inspected.mediaType },
        }).blob();
        if (blob.size !== inspected.byteLength) throw new Error("The staged Reality asset stream ended at the wrong byte length.");
        const candidate = await preflightRealityAssetInWorker(blob);
        const expectedFormat = inspected.format === "spz"
          ? "spz-v4"
          : inspected.format === "sog" ? "sog-v2" : "ply";
        if (candidate.descriptor.digest !== inspected.sha256
          || candidate.descriptor.byteLength !== inspected.byteLength
          || candidate.descriptor.format !== expectedFormat) {
          throw new Error("The staged Reality asset metadata does not match browser preflight.");
        }

        if (workspaceStoreRef.current !== store
          || workspaceGenerationRef.current !== workspaceGeneration
          || store.getState().workspaceId !== workspaceId
          || store.getState().revision !== baseRevision) {
          throw new Error("The project changed while the staged Reality asset was being verified.");
        }

        stored = await putRealityAssetBytes(candidate, blob);
        const registered = store.getState().realityAssets.get(candidate.descriptor.assetId);
        hadRegistration = Boolean(registered);
        if (registered && registered.digest !== candidate.descriptor.digest) {
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
          descriptor: structuredClone(candidate.descriptor),
          result,
        };
        await realityAssetCompletionLedgerRef.current.acknowledgeFirst(
          candidateHandle,
          completionContext,
          completion,
          () => client.completeAssetCandidate(candidateHandle, workspaceId),
        );
        announceRealityAssetCompletion(completion);
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
          announceRealityAssetCompletion(preservedCompletion);
          throw error;
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
        await client.cancelAssetCandidate(candidateHandle, workspaceId).catch(() => undefined);
        throw error;
      }
    });
    if (!completed) throw new Error("Another Workspace operation is still in progress.");
    return completed;
  }, [announceRealityAssetCompletion, applyWorkspaceSystemOperations, putRealityAssetBytes, runExclusive]);
  completeRealityAssetImportRef.current = completeRealityAssetImport;

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
          placement: defaultWorkspacePlacement(stageManifest, state.components.size),
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
          placement: defaultWorkspacePlacement(realityManifest, state.components.size + (stageId ? 1 : 0)),
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

  const handleAgentCommand = useCallback<AgentGatewayCommandHandler>(async (name, input, context) => {
    if (context.signal.aborted) throw new DOMException("Agent command cancelled", "AbortError");
    const workspaceRouter = workspaceAgentRouterRef.current;
    if (!workspaceRouter || !workspaceRouter.handles(name)) {
      throw new AgentGatewayCommandError("unsupported_command", `Unsupported Workspace command ${name}.`);
    }
    const result = await workspaceRouter.handle({ id: uid("workspace_command"), name, input });
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
  }, []);

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
      handler: handleAgentCommand,
      clientInstanceId: agentBrowserInstanceIdRef.current,
      onStatus: (status) => {
        if (!cancelled) setAgentStatus(status);
      },
      onConfig: (config) => {
        if (cancelled) return;
        setAgentConfig(config);
        setAgentEnabled(config.enabled);
        if (config.offerStatus !== "approval_granted") setApprovedAgentClaim(undefined);
        if (!config.enabled) {
          allowAgentDestructiveRef.current = false;
          setAllowAgentDestructive(false);
          setAgentSessionReady(false);
          setAgentHistoryOpen(false);
          setAgentBrowserOccupied(false);
        }
      },
    });
    agentGatewayRef.current = client;
    void client.fetchConfig().then((config) => {
      if (cancelled) return;
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
      setAgentError(friendlyError(error));
      setAgentStatus("disconnected");
    });
    return () => {
      cancelled = true;
      workspaceAgentControllerRef.current?.revokeAll();
      client.stop("disconnected");
      if (agentGatewayRef.current === client) agentGatewayRef.current = null;
    };
  }, [claimAndStartAgentBridge, handleAgentCommand]);

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
    notice(revokeWarning
      ? "Agent control was disabled locally, but the gateway could not confirm remote revocation."
      : "Agent connection disabled. Reconnect to return to the preserved Workspace.", revokeWarning ? "warning" : "success");
  }, [busy, notice, revokeAgentContexts]);

  const leaveOccupiedAgentConnection = useCallback(() => {
    agentGatewayRef.current?.stop("disconnected");
    setAgentBrowserOccupied(false);
    setAgentError(undefined);
    setAgentSessionReady(false);
    setAgentHistoryOpen(false);
    setAgentManageOpen(false);
    notice("This tab released the Agent connection. External control continues in the other tab.", "success");
  }, [notice]);

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
    allowAgentDestructiveRef.current = value;
    setAllowAgentDestructive(value);
    if (agentSessionReady) {
      revokeAgentContexts("permission_policy_changed");
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
  const offerApprovalGranted = agentConfig?.offerStatus === "approval_granted";
  const pairedAgent = pendingApproval ? {
    name: pendingApproval.clientName || "Unnamed agent",
    clientId: pendingApproval.clientId
      ? `${pendingApproval.clientId} · ${pendingApproval.fingerprint}`
      : pendingApproval.fingerprint,
    scopes: pendingApproval.scopes,
    connected: false,
  } : offerApprovalGranted && approvedAgentClaim ? approvedAgentClaim
  : agentConfig?.clientName || agentIsConnected ? {
    name: agentConfig?.clientName || "Unnamed MCP client",
    scopes: agentConfig?.clientScopes ?? (allowAgentDestructive
      ? ["workspace:read", "workspace:write", "workspace:history", "component:create", "component:update", "component:recipe_define", "component:invoke", "component:delete", "workspace:clear"]
      : ["workspace:read", "workspace:write", "workspace:history", "component:create", "component:update", "component:recipe_define", "component:invoke"]),
    connected: agentIsConnected,
  } : null;
  const externalControlActive = isAgentWorkspaceUnlocked(agentSessionReady, agentStatus);
  useEffect(() => {
    if (shouldClearRealityMeasurementForWorkspaceGate(externalControlActive, realityMeasurement)) {
      cancelRealityMeasurement();
    }
  }, [cancelRealityMeasurement, externalControlActive, realityMeasurement]);
  const agentConnectionStatus: AgentConnectionStatus = agentBrowserOccupied
    ? "occupied"
    : !agentEnabled
    ? "disabled"
    : pendingApproval || agentConfig?.offerStatus === "approval_pending"
      ? "approval"
      : offerApprovalGranted
        ? agentStatus === "disconnected" ? "disconnected" : "waiting"
        : agentSessionReady && agentIsConnected
          ? "connected"
          : agentStatus === "disconnected" || agentConfig?.offerStatus === "expired" || agentConfig?.offerStatus === "denied"
          ? "disconnected"
            : "waiting";
  const workspaceSnapshot = useMemo(() => toRenderSnapshot(workspace), [workspace]);
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
    () => hasSelectedSpatialComponent ? buildPhysicsValidationReport(workspace) : undefined,
    [hasSelectedSpatialComponent, workspace],
  );
  const selectedWorkspacePhysicsReport = workspacePhysicsReport
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
    .filter((component) => ["spatial-primitive", "spatial-entity", "model-assembly"].includes(component.type.typeId)
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
    id: "cad-step",
    label: "STEP",
    onExport: exportWorkspaceModelStep,
    isAvailable: (definition) => modelDefinitionStepCompatibility(definition).supported,
    unavailableReason: (definition) => modelDefinitionStepCompatibility(definition).reason
      ?? "This model is outside the STEP v1 subset.",
  }], [exportWorkspaceModel, exportWorkspaceModelMesh, exportWorkspaceModelStep]);
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

  const agentConnectionPageProps = {
    id: "agent-manage-panel",
    status: agentConnectionStatus,
    busy,
    error: agentError,
    pairedClient: pairedAgent,
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
      onProjectName={(name) => { setProjectName(name); setDirty(true); }}
      onUndo={() => void undo()}
      onRedo={() => void redo()}
      onOpen={() => fileRef.current?.click()}
      onSave={save}
      onNew={() => setConfirm("new")}
    />}
    {!externalControlActive ? <main className="agent-connection-gate" aria-label="Agent connection">
      <AgentConnectionPage {...agentConnectionPageProps} />
    </main> : <main
      id="workspace-panel"
      className={`app-workspace${externalControlActive ? " agent-control-active" : ""}`}
      aria-label="Workspace"
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
        interactionDisabled={agentManageOpen}
        onFrameAll={() => hybridCanvasRef.current?.frameAll()}
        onResetView={() => hybridCanvasRef.current?.resetView()}
        onZoomIn={() => hybridCanvasRef.current?.zoomIn()}
        onZoomOut={() => hybridCanvasRef.current?.zoomOut()}
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
          }}
        />
        <WorkspaceChrome
          key={`workspace-chrome-${workspaceRenderGeneration}`}
          catalog={workspaceCatalog}
          selected={selectedWorkspaceComponent}
          selectedPhysicsReport={selectedWorkspacePhysicsReport}
          sources={workspaceSources}
          bindingTargets={workspaceBindingTargets}
          bindingDiagnostics={bindingDiagnostics}
          disabled={busy}
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
          onImportRealityAsset={() => chooseRealityAssetFile()}
          onRelinkRealityAsset={chooseRealityAssetFile}
          onDeleteRealityAsset={deleteRealityAsset}
          onCreateShowcase={createMixedWorkspaceShowcase}
          onSaveInlineSource={saveWorkspaceInlineSource}
          onRefreshSource={(resourceId) => void refreshWorkspaceHostFeed(resourceId)}
          onPreviewHostFeed={previewWorkspaceHostFeed}
          onSaveHostFeed={saveWorkspaceHostFeed}
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
    </main>}
    {externalControlActive && recoveryAvailable && workspace.revision === 0 && workspace.components.size === 0 && <div className="recovery-banner" role="region" aria-label="Project recovery"><span>A local recovery is available.</span><button type="button" onClick={() => void restoreRecovery()}>Continue recovered project</button><button type="button" onClick={() => { safeStorageRemove(RECOVERY_KEY); setRecoveryAvailable(false); }}>Dismiss</button></div>}
    <input ref={fileRef} hidden type="file" accept=".json,.semaframe.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) { if (dirty) { setPendingFile(file); setConfirm("open"); } else void loadProject(file); } event.target.value = ""; }} />
    <input ref={realityFileRef} hidden type="file" accept=".ply,.spz,.sog,.zip,application/ply,application/x-spz,model/vnd.sog,application/zip" onChange={(event) => { const file = event.target.files?.[0]; const relinkAssetId = pendingRealityRelinkRef.current ?? undefined; pendingRealityRelinkRef.current = null; if (file) void importRealityAssetFile(file, relinkAssetId); event.target.value = ""; }} />
    <ConfirmDialog open={confirm === "new"} title="Start a new project?" detail={dirty ? "You have unsaved changes. Save a copy first if you want to return to this workspace." : "This starts an empty workspace. Add a 3D Stage only when you need a 3D world."} confirmLabel="Start new" tone={dirty ? "danger" : "default"} onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void resetProject(); }} />
    <ConfirmDialog open={confirm === "open"} title="Open another project?" detail="Your current project has unsaved changes. Opening another file will replace it in this window." confirmLabel="Open project" tone="danger" onCancel={() => { setConfirm(null); setPendingFile(null); }} onConfirm={() => { const file = pendingFile; setConfirm(null); setPendingFile(null); if (file) void loadProject(file); }} />
    <div className="toast-stack">{notices.map((item) => <div key={item.id} className={`toast tone-${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>{item.message}</div>)}</div>
    <div className="sr-status" role={status === "failed" ? "alert" : "status"} aria-live={status === "failed" ? "assertive" : "polite"} aria-atomic="true">{statusLabel(status)}</div>
  </div>
  </Suspense>;
}
