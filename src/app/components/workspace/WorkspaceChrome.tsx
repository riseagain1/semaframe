import { Boxes, Database, PackageOpen, PanelRightClose, ScanLine, SlidersHorizontal, TimerReset } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer";
import type { ComponentResizePolicy } from "../../../workspace/components";
import type { World3DPlacement } from "../../../workspace/components";
import type { ComponentActionRequest } from "../../../workspace/renderer/contracts";
import type { RealityMeasurementEvent } from "../../../renderer/reality";
import type { PhysicsBodyReport } from "../../../workspace/physics";
import {
  WorkspaceComponentLibrary,
  type ComponentCreationOptions,
  type ComponentLibraryItem,
} from "./WorkspaceComponentLibrary";
import {
  WorkspaceInspector,
  realityMeasurementStatus,
  type WorkspaceAssemblyOption,
  type WorkspaceComponentManifestUpgrade,
  type WorkspaceComponentHierarchyRequest,
  type WorkspaceComponentResizeRequest,
  type WorkspaceComponentTransformRequest,
  type WorkspaceComponentUpdateRequest,
  type WorkspaceComponentVisualEffectsRequest,
} from "./WorkspaceInspector";
import type {
  HostFeedFetchResponse,
  ResourceBindingDiagnostic,
  WorkspaceHostFeedPreviewRequest,
  WorkspaceHostFeedSaveRequest,
} from "../../../workspace/data";
import {
  WorkspaceSourcePanel,
  type WorkspaceInlineSourceSaveRequest,
  type WorkspaceSourceBindingTarget,
  type WorkspaceSourceItem,
} from "./WorkspaceSourcePanel";
import type { ModelDefinition } from "../../../workspace/modeling";
import {
  WorkspaceModelLibrary,
  type WorkspaceModelExportAction,
  type WorkspaceModelHierarchyItem,
  type WorkspaceModelPublishRequest,
} from "./WorkspaceModelLibrary";
import {
  WorkspaceRealityAssets,
  type WorkspaceRealityAssetItem,
  type WorkspacePhotoReconstructionCapability,
} from "./WorkspaceRealityAssets";
import type {
  PhotoReconstructionJobView,
  PhotoReconstructionProfile,
} from "../../../reconstruction/contracts";

export type WorkspacePanel = "library" | "inspector" | "models" | "reality" | "sources" | null;

export type WorkspaceChromeProps = Readonly<{
  catalog: readonly ComponentLibraryItem[];
  selected?: WorkspaceRenderComponent;
  selectedPhysicsReport?: PhysicsBodyReport;
  sources: readonly WorkspaceSourceItem[];
  bindingTargets?: readonly WorkspaceSourceBindingTarget[];
  bindingDiagnostics?: readonly ResourceBindingDiagnostic[];
  disabled?: boolean;
  panelState?: WorkspacePanel;
  onPanelStateChange?: (panel: WorkspacePanel) => void;
  configureRequestId?: string;
  onConfigureRequestChange?: (componentId: string | undefined) => void;
  onCreate: (typeId: string, options?: ComponentCreationOptions) => string | undefined;
  onAction: (request: ComponentActionRequest) => void;
  onUpdate: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  resizePolicy?: ComponentResizePolicy;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
  onVisualEffects?: (request: WorkspaceComponentVisualEffectsRequest) => void;
  manifestUpgrade?: WorkspaceComponentManifestUpgrade;
  onUpgradeManifest?: (componentId: string) => void;
  onCreateAssembly?: (componentId: string) => void;
  selectedWorldPlacement?: World3DPlacement;
  assemblyOptions?: readonly WorkspaceAssemblyOption[];
  realityProxyOptions?: readonly WorkspaceAssemblyOption[];
  realityMeasurement?: RealityMeasurementEvent;
  onStartRealityMeasurement?: (componentId: string) => boolean;
  onCancelRealityMeasurement?: () => void;
  onTransform?: (request: WorkspaceComponentTransformRequest) => void;
  onReparent?: (request: WorkspaceComponentHierarchyRequest) => boolean | void;
  onSelectComponent?: (componentId: string) => void;
  selectedDescendantCount?: number;
  onDeleteComponent?: (componentId: string) => boolean | void;
  modelDefinitions?: readonly ModelDefinition[];
  modelHierarchyItems?: readonly WorkspaceModelHierarchyItem[];
  onPublishModel?: (request: WorkspaceModelPublishRequest) => boolean | void;
  onInstantiateModel?: (definition: ModelDefinition) => boolean | void;
  modelExportActions?: readonly WorkspaceModelExportAction[];
  onDeleteModel?: (definition: ModelDefinition) => boolean | void;
  onCreateModelExample?: () => void;
  realityAssets?: readonly WorkspaceRealityAssetItem[];
  realityImportBusy?: boolean;
  realityImportStatus?: string;
  realityReconstructionCapability?: WorkspacePhotoReconstructionCapability;
  realityReconstructionProfile?: PhotoReconstructionProfile;
  realityReconstructionJob?: PhotoReconstructionJobView;
  realityReconstructionBusy?: boolean;
  realityReconstructionStatus?: string;
  onImportRealityAsset?: () => void;
  onReconstructRealityFromPhotos?: () => void;
  onRealityReconstructionProfile?: (profile: PhotoReconstructionProfile) => void;
  onCancelRealityReconstruction?: () => void;
  onRelinkRealityAsset?: (assetId: string) => void;
  onDeleteRealityAsset?: (assetId: string) => boolean | void | Promise<boolean | void>;
  onCreateShowcase: () => void;
  onSaveInlineSource?: (request: WorkspaceInlineSourceSaveRequest) => boolean;
  onRefreshSource?: (sourceId: string) => void;
  onPreviewHostFeed?: (request: WorkspaceHostFeedPreviewRequest) => Promise<HostFeedFetchResponse>;
  onSaveHostFeed?: (request: WorkspaceHostFeedSaveRequest) => boolean | Promise<boolean>;
  onUnbindSource?: (bindingId: string) => void;
  onDeleteSource?: (sourceId: string) => void;
  /** Keep only the human-approved Sources surface while external control stays connected. */
  sourcesOnly?: boolean;
}>;

/** Human controls for the same component surface exposed to external clients. */
export function WorkspaceChrome({
  catalog,
  selected,
  selectedPhysicsReport,
  sources,
  bindingTargets,
  bindingDiagnostics,
  disabled = false,
  onCreate,
  onAction,
  onUpdate,
  resizePolicy,
  onResize,
  onVisualEffects,
  manifestUpgrade,
  onUpgradeManifest,
  onCreateAssembly,
  selectedWorldPlacement,
  assemblyOptions,
  realityProxyOptions,
  realityMeasurement,
  onStartRealityMeasurement,
  onCancelRealityMeasurement,
  onTransform,
  onReparent,
  onSelectComponent,
  selectedDescendantCount,
  onDeleteComponent,
  modelDefinitions = [],
  modelHierarchyItems,
  onPublishModel,
  onInstantiateModel,
  modelExportActions,
  onDeleteModel,
  onCreateModelExample,
  realityAssets = [],
  realityImportBusy,
  realityImportStatus,
  realityReconstructionCapability,
  realityReconstructionProfile,
  realityReconstructionJob,
  realityReconstructionBusy,
  realityReconstructionStatus,
  onImportRealityAsset,
  onReconstructRealityFromPhotos,
  onRealityReconstructionProfile,
  onCancelRealityReconstruction,
  onRelinkRealityAsset,
  onDeleteRealityAsset,
  onCreateShowcase,
  onSaveInlineSource,
  onRefreshSource,
  onPreviewHostFeed,
  onSaveHostFeed,
  onUnbindSource,
  onDeleteSource,
  sourcesOnly = false,
  panelState,
  onPanelStateChange,
  configureRequestId,
  onConfigureRequestChange,
}: WorkspaceChromeProps) {
  const [localPanel, setLocalPanel] = useState<WorkspacePanel>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [localConfigureRequestId, setLocalConfigureRequestId] = useState<string>();
  const panel = panelState === undefined ? localPanel : panelState;
  const pendingConfigureId = onConfigureRequestChange
    ? configureRequestId
    : localConfigureRequestId;
  const setPanel = useCallback((next: WorkspacePanel) => {
    if (panelState === undefined) setLocalPanel(next);
    else onPanelStateChange?.(next);
  }, [onPanelStateChange, panelState]);
  const setPendingConfigureId = useCallback((next: string | undefined) => {
    if (onConfigureRequestChange) onConfigureRequestChange(next);
    else setLocalConfigureRequestId(next);
  }, [onConfigureRequestChange]);

  useEffect(() => {
    if (!disabled) return;
    onCancelRealityMeasurement?.();
  }, [disabled, onCancelRealityMeasurement]);
  useEffect(() => {
    if (!pendingConfigureId || selected?.id !== pendingConfigureId) return;
    setPanel("inspector");
    setPendingConfigureId(undefined);
  }, [pendingConfigureId, selected, setPanel, setPendingConfigureId]);
  useEffect(() => {
    if (!sourcesOnly) return;
    if (panel && panel !== "sources") setPanel(null);
    onCancelRealityMeasurement?.();
  }, [onCancelRealityMeasurement, panel, sourcesOnly]);
  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.scrollTop = 0;
    panelRef.current.scrollLeft = 0;
  }, [panel]);
  useEffect(() => {
    if (!disabled && !sourcesOnly
      && (realityMeasurement?.kind === "complete" || realityMeasurement?.kind === "miss")) {
      setPanel("inspector");
    }
  }, [disabled, realityMeasurement, sourcesOnly]);

  const closePanel = () => {
    setPendingConfigureId(undefined);
    setPanel(null);
  };
  const toggle = (next: Exclude<WorkspacePanel, null>) => {
    setPendingConfigureId(undefined);
    setPanel(panel === next ? null : next);
  };
  const startRealityMeasurement = onStartRealityMeasurement
    ? (componentId: string) => {
        const started = onStartRealityMeasurement(componentId);
        if (started) setPanel(null);
        return started;
      }
    : undefined;
  const createFromLibrary = (typeId: string, options?: ComponentCreationOptions) => {
    const configureOnCreate = catalog.find((item) => item.typeId === typeId)?.configureOnCreate === true;
    const createdId = onCreate(typeId, options);
    if (configureOnCreate && createdId) setPendingConfigureId(createdId);
  };
  return (
    <>
      <nav className="workspace-tool-dock" aria-label="Workspace component tools">
        {!sourcesOnly && <button type="button" disabled={disabled} aria-expanded={panel === "library"} aria-controls="workspace-tool-panel" onClick={() => toggle("library")}>
          <Boxes size={17} /><span>Components</span>
        </button>}
        {!sourcesOnly && <button type="button" disabled={disabled || !selected} aria-expanded={panel === "inspector"} aria-controls="workspace-tool-panel" onClick={() => toggle("inspector")}>
          <SlidersHorizontal size={17} /><span>Inspector</span>
        </button>}
        {!sourcesOnly && <button type="button" disabled={disabled} aria-expanded={panel === "models"} aria-controls="workspace-tool-panel" onClick={() => toggle("models")}>
          <PackageOpen size={17} /><span>Models</span>
        </button>}
        {!sourcesOnly && <button type="button" disabled={disabled} aria-expanded={panel === "reality"} aria-controls="workspace-tool-panel" onClick={() => toggle("reality")}>
          <ScanLine size={17} /><span>Reality</span>
        </button>}
        <button type="button" disabled={disabled} aria-expanded={panel === "sources"} aria-controls="workspace-tool-panel" onClick={() => toggle("sources")}>
          <Database size={17} /><span>Sources</span>
        </button>
        {!sourcesOnly && <button type="button" disabled={disabled} onClick={onCreateShowcase} title="Add a working timer over the 3D scene">
          <TimerReset size={17} /><span>Mixed demo</span>
        </button>}
      </nav>
      {realityMeasurement && panel !== "inspector" && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {realityMeasurementStatus(realityMeasurement)}
      </p>}
      {panel && (
        <div
          id="workspace-tool-panel"
          className="workspace-tool-panel"
          role="region"
          aria-label={`${panel} panel`}
          aria-disabled={disabled || undefined}
          inert={disabled || undefined}
        >
          <header className="workspace-tool-panel__header">
            <strong>{{
              library: "Components",
              inspector: "Inspector",
              models: "Models",
              reality: "Reality",
              sources: "Sources",
            }[panel]}</strong>
            <button className="workspace-tool-panel__close" type="button" aria-label={`Close ${panel} panel`} onClick={closePanel}>
              <PanelRightClose size={17} />
            </button>
          </header>
          <div ref={panelRef} className="workspace-tool-panel__content">
            {panel === "library" && <WorkspaceComponentLibrary items={catalog} onCreate={createFromLibrary} />}
            {panel === "inspector" && (
              <WorkspaceInspector
                component={selected}
                onAction={onAction}
                onUpdate={onUpdate}
                resizePolicy={resizePolicy}
                onResize={onResize}
                onVisualEffects={onVisualEffects}
                manifestUpgrade={manifestUpgrade}
                onUpgradeManifest={onUpgradeManifest}
                onCreateAssembly={onCreateAssembly}
                physicsReport={selectedPhysicsReport}
                worldPlacement={selectedWorldPlacement}
                assemblyOptions={assemblyOptions}
                realityProxyOptions={realityProxyOptions}
                realityMeasurement={realityMeasurement}
                onStartRealityMeasurement={startRealityMeasurement}
                onCancelRealityMeasurement={onCancelRealityMeasurement}
                onTransform={onTransform}
                onReparent={onReparent}
                onSelectComponent={onSelectComponent}
                descendantCount={selectedDescendantCount}
                onDeleteComponent={onDeleteComponent}
              />
            )}
            {panel === "models" && <WorkspaceModelLibrary
              definitions={modelDefinitions}
              selectedAssembly={selected?.type.typeId === "model-assembly"
                ? { id: selected.id, label: selected.label }
                : undefined}
              disabled={disabled}
              onPublish={onPublishModel}
              onInstantiate={onInstantiateModel}
              exportActions={modelExportActions}
              onDelete={onDeleteModel}
              onCreateExample={onCreateModelExample}
              hierarchyItems={modelHierarchyItems}
              selectedComponentId={selected?.id}
              onSelectComponent={onSelectComponent}
            />}
            {panel === "reality" && <WorkspaceRealityAssets
              items={realityAssets}
              disabled={disabled}
              importBusy={realityImportBusy}
              importStatus={realityImportStatus}
              reconstructionCapability={realityReconstructionCapability}
              reconstructionProfile={realityReconstructionProfile}
              reconstructionJob={realityReconstructionJob}
              reconstructionBusy={realityReconstructionBusy}
              reconstructionStatus={realityReconstructionStatus}
              onImport={onImportRealityAsset}
              onReconstruct={onReconstructRealityFromPhotos}
              onReconstructionProfile={onRealityReconstructionProfile}
              onCancelReconstruction={onCancelRealityReconstruction}
              onRelink={onRelinkRealityAsset}
              onDelete={onDeleteRealityAsset}
              onSelectComponent={onSelectComponent}
            />}
            {panel === "sources" && <WorkspaceSourcePanel
              sources={sources}
              bindingTargets={bindingTargets}
              diagnostics={bindingDiagnostics}
              onSaveInlineSource={onSaveInlineSource}
              onRefresh={onRefreshSource}
              onPreviewHostFeed={onPreviewHostFeed}
              onSaveHostFeed={onSaveHostFeed}
              onUnbindSource={onUnbindSource}
              onDeleteSource={onDeleteSource}
            />}
          </div>
        </div>
      )}
    </>
  );
}
