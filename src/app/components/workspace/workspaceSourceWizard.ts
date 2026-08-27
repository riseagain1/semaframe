import type { JSONValue } from "../../../workspace/components";
import {
  deriveHostFeedMappingPresets,
  type HostFeedFormat,
  type HostFeedMappingPreset,
  type ResourceRefreshPolicy,
} from "../../../workspace/data";

export type WorkspaceSourceWizardKind = "local" | "https";
export type WorkspaceSourceWizardStep = "choose" | "configure" | "preview" | "destination" | "done";
export type WorkspaceSourceCreateTargetType = "data-panel" | "chart" | "table";

export type WorkspaceSourceCreateTargetPlan = Readonly<{
  typeId: WorkspaceSourceCreateTargetType;
  label: string;
  description: string;
  mapping: HostFeedMappingPreset;
  available: boolean;
  unavailableReason?: string;
}>;

const TARGET_COPY: Readonly<Record<WorkspaceSourceCreateTargetType, Readonly<{
  label: string;
  description: string;
}>>> = {
  "data-panel": {
    label: "Data Panel",
    description: "Inspect the complete snapshot as structured data.",
  },
  chart: {
    label: "Chart",
    description: "Plot normalized labels and numeric series.",
  },
  table: {
    label: "Table",
    description: "Show records as columns and rows.",
  },
};

/**
 * Produce closed, declarative mappings for components the host can create in
 * the same transaction as a source. No expression language or executable
 * transformation is introduced here.
 */
export function planWorkspaceSourceCreateTargets(data: JSONValue): readonly WorkspaceSourceCreateTargetPlan[] {
  const presets = deriveHostFeedMappingPresets(data);
  return (["data-panel", "chart", "table"] as const).map((typeId) => {
    const mapping = presets.find((candidate) => candidate.targetType === typeId);
    const copy = TARGET_COPY[typeId];
    if (mapping) {
      return {
        typeId,
        ...copy,
        mapping,
        available: true,
      };
    }
    return {
      typeId,
      ...copy,
      mapping: {
        id: `unavailable-${typeId}`,
        label: `No compatible ${copy.label} mapping`,
        targetType: typeId,
        bindings: [],
      },
      available: false,
      unavailableReason: typeId === "chart"
        ? "This preview does not contain normalized labels and series."
        : "This preview does not contain compatible record rows or table data.",
    };
  });
}

/** A stable identity for the exact host-approved preview configuration. */
export function hostFeedPreviewConfigurationKey(input: Readonly<{
  url: string;
  format: HostFeedFormat;
  policy: ResourceRefreshPolicy;
}>): string {
  return JSON.stringify({
    url: input.url.trim(),
    format: input.format,
    policy: input.policy.mode === "interval"
      ? {
        mode: input.policy.mode,
        intervalMs: input.policy.intervalMs,
        offline: input.policy.offline,
      }
      : {
        mode: input.policy.mode,
        offline: input.policy.offline,
      },
  });
}
