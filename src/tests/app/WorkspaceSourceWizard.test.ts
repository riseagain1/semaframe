import { describe, expect, it } from "vitest";
import {
  hostFeedPreviewConfigurationKey,
  planWorkspaceSourceCreateTargets,
} from "../../app/components/workspace/workspaceSourceWizard";

describe("workspaceSourceWizard", () => {
  it("plans only closed mappings supported by the preview shape", () => {
    const chart = planWorkspaceSourceCreateTargets({
      labels: ["09:30", "09:31"],
      series: [{ id: "price", label: "Price", values: [4, 5] }],
    });
    expect(chart.find(({ typeId }) => typeId === "data-panel")).toMatchObject({ available: true });
    expect(chart.find(({ typeId }) => typeId === "chart")).toMatchObject({
      available: true,
      mapping: {
        targetType: "chart",
        bindings: [
          { targetProp: "labels", sourcePath: "$.labels", transform: { kind: "identity" } },
          { targetProp: "series", sourcePath: "$.series", transform: { kind: "identity" } },
        ],
      },
    });
    expect(chart.map(({ typeId }) => typeId)).toEqual(["data-panel", "chart", "table"]);

    const rows = planWorkspaceSourceCreateTargets([{ city: "Paris", temp: 19 }]);
    expect(rows.find(({ typeId }) => typeId === "table")).toMatchObject({
      available: true,
      mapping: {
        targetType: "table",
        bindings: [{ targetProp: "rows", sourcePath: "$", transform: { kind: "identity" } }],
      },
    });
    expect(planWorkspaceSourceCreateTargets(42).find(({ typeId }) => typeId === "chart"))
      .toMatchObject({ available: false });
  });

  it("changes preview identity when URL, format, or refresh policy changes", () => {
    const base = {
      url: "https://feeds.example.test/data.json",
      format: "json" as const,
      policy: { mode: "manual" as const, offline: "keep_last_good" as const },
    };
    const key = hostFeedPreviewConfigurationKey(base);
    expect(hostFeedPreviewConfigurationKey({ ...base, url: "https://feeds.example.test/other.json" })).not.toBe(key);
    expect(hostFeedPreviewConfigurationKey({ ...base, format: "csv" })).not.toBe(key);
    expect(hostFeedPreviewConfigurationKey({
      ...base,
      policy: { mode: "interval", intervalMs: 60_000, offline: "keep_last_good" },
    })).not.toBe(key);
  });
});
