import { Boxes, Database, PackageOpen, PanelRightClose, ScanLine, SlidersHorizontal, TimerReset } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer";
import type { ComponentResizePolicy } from "../../../workspace/components";
import type { World3DPlacement } from "../../../workspace/components";
import type { ComponentActionRequest } from "../../../workspace/renderer/contracts";
import type { PhysicsBodyReport } from "../../../workspace/physics";
import {
  WorkspaceComponentLibrary,
  type ComponentCreationOptions,
  type ComponentLibraryItem,
} from "./WorkspaceComponentLibrary";
import {
  WorkspaceInspector,
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
} from "./WorkspaceRealityAssets";

type WorkspacePanel = "library" | "inspector" | "models" | "reality" | "sources" | null;

export type WorkspaceChromeProps = Readonly<{
  catalog: readonly ComponentLibraryItem[];
  selected?: WorkspaceRenderComponent;
  selectedPhysicsReport?: PhysicsBodyReport;
  sources: readonly WorkspaceSourceItem[];
  bindingTargets?: readonly WorkspaceSourceBindingTarget[];
  bindingDiagnostics?: readonly ResourceBindingDiagnostic[];
  disabled?: boolean;
  onCreate: (typeId: string, options?: ComponentCreationOptions) => void;
  onAction: (request: ComponentActionRequest) => void;
  onUpdate: (request: WorkspaceComponentUpdateRequest) => void;
  resizePolicy?: ComponentResizePolicy;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
  onVisualEffects?: (request: WorkspaceComponentVisualEffectsRequest) => void;
  manifestUpgrade?: WorkspaceComponentManifestUpgrade;
  onUpgradeManifest?: (componentId: string) => void;
  onCreateAssembly?: (componentId: string) => void;
  selectedWorldPlacement?: World3DPlacement;
  assemblyOptions?: readonly WorkspaceAssemblyOption[];
  realityProxyOptions?: readonly WorkspaceAssemblyOption[];
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
  onImportRealityAsset?: () => void;
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
  onImportRealityAsset,
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
}: WorkspaceChromeProps) {
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) setPanel(null);
  }, [disabled]);
  useEffect(() => {
    if (sourcesOnly && panel && panel !== "sources") setPanel(null);
  }, [panel, sourcesOnly]);
  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.scrollTop = 0;
    panelRef.current.scrollLeft = 0;
  }, [panel]);

  const toggle = (next: Exclude<WorkspacePanel, null>) => setPanel((current) => current === next ? null : next);
  const createFromLibrary = (typeId: string, options?: ComponentCreationOptions) => {
    onCreate(typeId, options);
    if (catalog.find((item) => item.typeId === typeId)?.configureOnCreate) setPanel("inspector");
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
      {panel && (
        <div id="workspace-tool-panel" className="workspace-tool-panel" role="region" aria-label={`${panel} panel`}>
          <header className="workspace-tool-panel__header">
            <strong>{{
              library: "Components",
              inspector: "Inspector",
              models: "Models",
              reality: "Reality",
              sources: "Sources",
            }[panel]}</strong>
            <button className="workspace-tool-panel__close" type="button" aria-label={`Close ${panel} panel`} onClick={() => setPanel(null)}>
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
              onImport={onImportRealityAsset}
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
