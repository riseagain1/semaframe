import { Boxes, Database, PanelRightClose, SlidersHorizontal, TimerReset } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer";
import type { ComponentResizePolicy } from "../../../workspace/components";
import type { ComponentActionRequest } from "../../../workspace/renderer/contracts";
import type { PhysicsBodyReport } from "../../../workspace/physics";
import { WorkspaceComponentLibrary, type ComponentLibraryItem } from "./WorkspaceComponentLibrary";
import {
  WorkspaceInspector,
  type WorkspaceComponentManifestUpgrade,
  type WorkspaceComponentResizeRequest,
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

type WorkspacePanel = "library" | "inspector" | "sources" | null;

export type WorkspaceChromeProps = Readonly<{
  catalog: readonly ComponentLibraryItem[];
  selected?: WorkspaceRenderComponent;
  selectedPhysicsReport?: PhysicsBodyReport;
  sources: readonly WorkspaceSourceItem[];
  bindingTargets?: readonly WorkspaceSourceBindingTarget[];
  bindingDiagnostics?: readonly ResourceBindingDiagnostic[];
  disabled?: boolean;
  onCreate: (typeId: string) => void;
  onAction: (request: ComponentActionRequest) => void;
  onUpdate: (request: WorkspaceComponentUpdateRequest) => void;
  resizePolicy?: ComponentResizePolicy;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
  onVisualEffects?: (request: WorkspaceComponentVisualEffectsRequest) => void;
  manifestUpgrade?: WorkspaceComponentManifestUpgrade;
  onUpgradeManifest?: (componentId: string) => void;
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

  const toggle = (next: Exclude<WorkspacePanel, null>) => setPanel((current) => current === next ? null : next);
  const createFromLibrary = (typeId: string) => {
    onCreate(typeId);
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
        <button type="button" disabled={disabled} aria-expanded={panel === "sources"} aria-controls="workspace-tool-panel" onClick={() => toggle("sources")}>
          <Database size={17} /><span>Sources</span>
        </button>
        {!sourcesOnly && <button type="button" disabled={disabled} onClick={onCreateShowcase} title="Add a working timer over the 3D scene">
          <TimerReset size={17} /><span>Mixed demo</span>
        </button>}
      </nav>
      {panel && (
        <div ref={panelRef} id="workspace-tool-panel" className="workspace-tool-panel" role="region" aria-label={`${panel} panel`}>
          <button className="workspace-tool-panel__close" type="button" aria-label={`Close ${panel} panel`} onClick={() => setPanel(null)}>
            <PanelRightClose size={17} />
          </button>
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
              physicsReport={selectedPhysicsReport}
            />
          )}
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
      )}
    </>
  );
}
