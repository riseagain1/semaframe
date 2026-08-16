import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";
import type { JSONObject } from "../../../workspace/components/componentTypes";
import { formatTimer, projectTimer } from "../../../workspace/renderer/timerProjection";

export type TimerViewProps = Readonly<{
  component: WorkspaceRenderComponent;
  now?: () => number;
  onAction?: (action: string, input?: JSONObject) => void;
}>;

export function TimerView({ component, now = Date.now, onAction }: TimerViewProps) {
  const [observedAt, setObservedAt] = useState(now);
  const timer = useMemo(() => projectTimer({
    props: component.props,
    durableState: component.durableState,
    nowMs: observedAt,
  }), [component.durableState, component.props, observedAt]);
  const isRunning = timer.phase === "running";

  useEffect(() => {
    setObservedAt(now());
    if (!isRunning) return;
    const interval = window.setInterval(() => setObservedAt(now()), 250);
    return () => window.clearInterval(interval);
  }, [isRunning, now, timer.runGeneration]);

  const label = stringValue(component.props.label) ?? component.label;
  const formatted = formatTimer(timer.remainingMs, component.props.format);
  const primaryAction = timer.phase === "running"
    ? "pause"
    : timer.phase === "paused"
      ? "resume"
      : timer.phase === "completed"
        ? "reset"
        : "start";
  const primaryLabel = `${capitalize(primaryAction)} timer`;
  const actionsLocked = component.locks.actions === true;

  return (
    <section className={`workspace-timer is-${timer.phase}`} aria-label={`${label} timer`}>
      <div className="workspace-timer__header">
        <span>{label}</span>
        <span className="workspace-timer__phase">{timer.phase}</span>
      </div>
      <output
        className="workspace-timer__readout"
        aria-live={timer.remainingMs <= 10_000 && isRunning ? "polite" : "off"}
        aria-label={`${formatted} remaining`}
      >
        {formatted}
      </output>
      {component.props.showProgress !== false && (
        <progress
          aria-label="Timer progress"
          max={1}
          value={timer.progress}
        />
      )}
      <div className="workspace-timer__actions" data-no-canvas-drag="true">
        <button
          type="button"
          disabled={actionsLocked}
          onClick={() => onAction?.(primaryAction)}
          aria-label={primaryLabel}
        >
          {capitalize(primaryAction)}
        </button>
        {timer.phase !== "idle" && primaryAction !== "reset" && (
          <button
            type="button"
            disabled={actionsLocked}
            onClick={() => onAction?.("reset")}
            aria-label="Reset timer"
          >
            Reset
          </button>
        )}
      </div>
    </section>
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
