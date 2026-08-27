import {
  Box,
  Building2,
  DatabaseZap,
  FileUp,
  Gauge,
  Sparkles,
  X,
} from "lucide-react";
import { useId, type ComponentType } from "react";
import "./WorkspaceStartPanel.css";

export type WorkspaceStartPanelProps = Readonly<{
  disabled?: boolean;
  agentName?: string;
  onBuildSpace: () => void;
  onCreateDashboard: () => void;
  onOpenReality: () => void;
  onConnectData: () => void;
  onTryExample: () => void;
  onOpenProject?: () => void;
  onDismiss?: () => void;
}>;

type StartChoice = Readonly<{
  label: string;
  description: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  action: () => void;
}>;

/**
 * A non-modal, goal-first entry surface. It only emits intent; the host keeps
 * authority over project loading, Workspace transactions, and Agent prompts.
 */
export function WorkspaceStartPanel({
  disabled = false,
  agentName,
  onBuildSpace,
  onCreateDashboard,
  onOpenReality,
  onConnectData,
  onTryExample,
  onOpenProject,
  onDismiss,
}: WorkspaceStartPanelProps) {
  const titleId = useId();
  const choices: readonly StartChoice[] = [
    {
      label: "Build a 3D space",
      description: "Arrange editable objects, assemblies, collisions, and physical intent.",
      icon: Box,
      action: onBuildSpace,
    },
    {
      label: "Create a dashboard",
      description: "Place clear 2D controls, charts, and panels in or around the scene.",
      icon: Gauge,
      action: onCreateDashboard,
    },
    {
      label: "Bring in a real space",
      description: "Import or reconstruct a visual Reality layer, then add editable proxies.",
      icon: Building2,
      action: onOpenReality,
    },
    {
      label: "Connect live data",
      description: "Map a snapshot or host-brokered feed into an inspectable panel.",
      icon: DatabaseZap,
      action: onConnectData,
    },
    {
      label: "Try a working example",
      description: "Open a complete scene that demonstrates interaction and validation.",
      icon: Sparkles,
      action: onTryExample,
    },
  ];

  return (
    <section className="workspace-start-panel" aria-labelledby={titleId}>
      <header className="workspace-start-panel__header">
        <div>
          <p className="workspace-start-panel__eyebrow">Start center</p>
          <h2 id={titleId}>What would you like to make?</h2>
          <p>
            Ask {agentName?.trim() || "your connected Agent"} in your own words, or choose a
            starting point below. Every result stays editable in this Workspace.
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="workspace-start-panel__dismiss"
            onClick={onDismiss}
            disabled={disabled}
            aria-label="Close Start Center"
          >
            <X size={17} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="workspace-start-panel__choices" aria-label="Starting points">
        {choices.map((choice) => {
          const Icon = choice.icon;
          return (
            <button
              key={choice.label}
              type="button"
              className="workspace-start-panel__choice"
              onClick={choice.action}
              disabled={disabled}
            >
              <span className="workspace-start-panel__choice-icon"><Icon size={19} aria-hidden={true} /></span>
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </span>
            </button>
          );
        })}
      </div>

      <footer className="workspace-start-panel__footer">
        {onOpenProject && (
          <button type="button" onClick={onOpenProject} disabled={disabled}>
            <FileUp size={15} aria-hidden="true" />Open existing project
          </button>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} disabled={disabled}>Start with an empty Workspace</button>
        )}
      </footer>
    </section>
  );
}
